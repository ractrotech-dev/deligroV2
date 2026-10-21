import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

import '../../core/api.dart';
import '../../core/errors.dart';
import '../../core/format.dart';
import '../../core/pricing.dart';
import '../../data/checkout_repository.dart';
import '../../models/address.dart';
import '../../models/order.dart';
import '../../models/settings.dart';
import '../../state/cart.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';
import '../location/address_form.dart';
import '../location/map_picker.dart';
import 'delivery_details.dart';

/// Checkout (components/checkout/checkout-view.tsx). Everything here is a
/// preview: `/api/orders` re-prices, re-checks the area and the payment rules,
/// and its answer is the real bill.
class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

enum _Phase { ready, placing, paying, done }

class _Coupon {
  const _Coupon(this.code, this.discount, this.pricedAt, this.slug);
  final String code;
  final int discount;

  /// The subtotal and shop it was quoted for; a moved basket drops it.
  final int pricedAt;
  final String slug;
}

class _PayOutcome {
  const _PayOutcome.paid(PaymentSuccessResponse this.success)
      : cancelled = false,
        wallet = null;
  const _PayOutcome.failed({this.cancelled = false})
      : success = null,
        wallet = null;
  const _PayOutcome.wallet(this.wallet)
      : success = null,
        cancelled = false;

  final PaymentSuccessResponse? success;
  final bool cancelled;
  final String? wallet;
}

/// What the shop takes for this total (paymentAvailability in cod-rules.ts).
class _Availability {
  _Availability(PaymentRules rules, bool platformOnline, int total)
      : limit = max(0, rules.codMaxOrder),
        online = rules.acceptOnline && platformOnline,
        overLimit = rules.codMaxOrder > 0 && total > rules.codMaxOrder,
        codOff = !rules.acceptCod;

  final int limit;
  final bool online;
  final bool overLimit;
  final bool codOff;

  bool get cod => !codOff && !overLimit;
  bool get noMethod => !cod && !online;

  String? get notice {
    if (noMethod) return 'This shop cannot take payment right now. Please try again a little later.';
    if (overLimit) {
      return online
          ? 'Orders above ${rupees(limit)} must be paid online.'
          : 'This shop takes cash only up to ${rupees(limit)}. Remove a few items to place this order.';
    }
    if (codOff) return 'This shop takes online payment only.';
    return null;
  }

  String get summary {
    if (cod && online) return 'Pay now by UPI or card, or pay the courier on delivery.';
    if (online) return 'Pay now by UPI, card, netbanking or wallet.';
    if (cod) return 'Pay the courier in cash when your order arrives.';
    return 'Payment is not available for this shop right now.';
  }
}

const _couponReasons = {
  'empty',
  'invalid',
  'expired',
  'min_order',
  'wrong_restaurant',
  'already_used',
  'already_applied',
  'exhausted',
  'order_not_open',
};

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  // ---- address ----
  String? _selectedId;
  bool _userPicked = false;
  bool _autoPickTried = false;
  String? _autoPicked;
  bool _pinBusy = false;

  /// Serviceability per `slug|lat,lng`. A null value is a check that could
  /// not be made: the order API decides then, but the button stops waiting.
  final Map<String, Serviceability?> _areas = {};
  final Set<String> _areaInFlight = {};

  // ---- delivery details: flat/floor/gate go on the address line, the note
  // for the courier travels on its own as `instructions` ----
  final _apartment = TextEditingController();
  final _entry = TextEditingController();
  final _floor = TextEditingController();
  final _building = TextEditingController();
  final _note = TextEditingController();

  int _tip = 0;
  String _method = 'cod';

  // ---- coupon ----
  final _couponCtrl = TextEditingController();
  _Coupon? _coupon;
  bool _couponBusy = false;
  String? _couponError;

  // ---- payment rules ----
  PaymentRules? _rules;
  String? _rulesFor;

  // ---- submit ----
  _Phase _phase = _Phase.ready;
  String? _error;

  /// One key per checkout visit, minted on the first submit and reused on
  /// every retry, so the server can tell a re-tap from a new order.
  String? _idempotencyKey;
  Razorpay? _razorpay;
  Completer<_PayOutcome>? _payment;

  @override
  void initState() {
    super.initState();
    _couponCtrl.addListener(() => setState(() {}));
    // A quote is only good for the basket it was priced against.
    ref.listenManual<CartState>(cartProvider, (prev, next) {
      final c = _coupon;
      if (c == null || _phase == _Phase.done) return;
      if (next.subtotal != c.pricedAt || next.slug != c.slug) {
        setState(() {
          _coupon = null;
          _couponError = next.slug != c.slug
              ? 'You\'re ordering from a different restaurant — apply the code again.'
              : 'Your basket changed — apply the code again.';
        });
      }
    });
  }

  @override
  void dispose() {
    _razorpay?.clear();
    for (final c in [_apartment, _entry, _floor, _building, _note, _couponCtrl]) {
      c.dispose();
    }
    super.dispose();
  }

  // ---------------------------------------------------------------- address

  SavedAddress? _resolve(List<SavedAddress> list, DeliveryLocation loc) {
    if (list.isEmpty) return null;
    if (_selectedId != null) {
      final m = list.where((a) => a.id == _selectedId).firstOrNull;
      if (m != null) return m;
    }
    return list.where((a) => a.id == loc.addressId).firstOrNull ??
        list.where((a) => a.isDefault).firstOrNull ??
        list.first;
  }

  static String _areaKey(String slug, SavedAddress a) => '$slug|${a.lat},${a.lng}';

  Future<Serviceability?> _measure(String slug, SavedAddress a) async {
    final key = _areaKey(slug, a);
    if (_areas.containsKey(key)) return _areas[key];
    try {
      final r = await ref.read(checkoutRepoProvider).serviceability(slug, a.lat!, a.lng!);
      _areas[key] = r;
      return r;
    } catch (_) {
      _areas[key] = null;
      return null;
    }
  }

  /// Kicks off the area check for the chosen pin; safe to call from build.
  void _ensureArea(String slug, SavedAddress a) {
    if (!a.pinned) return;
    final key = _areaKey(slug, a);
    if (_areas.containsKey(key) || _areaInFlight.contains(key)) return;
    _areaInFlight.add(key);
    _measure(slug, a).then((r) {
      _areaInFlight.remove(key);
      if (!mounted) return;
      setState(() {});
      if (r != null && r.blocks) _maybeAutoPick(slug, a);
    });
  }

  /// The default address is outside this shop's area but another saved one
  /// isn't: switch to it once, and say so. Never overrides a deliberate pick,
  /// and doesn't change the saved default.
  Future<void> _maybeAutoPick(String slug, SavedAddress blocked) async {
    if (_userPicked || _autoPickTried) return;
    final list = ref.read(addressesProvider).value ?? const [];
    final current = _resolve(list, ref.read(locationProvider));
    if (current?.id != blocked.id) return;
    _autoPickTried = true;
    for (final a in list) {
      if (a.id == blocked.id || !a.pinned) continue;
      final r = await _measure(slug, a);
      if (!mounted || _userPicked) return;
      if (r != null && !r.blocks) {
        final area = addressLocality(a.line);
        setState(() {
          _selectedId = a.id;
          _autoPicked = area == null ? a.label : '${a.label} · $area';
        });
        return;
      }
    }
  }

  void _pick(String id) => setState(() {
        _selectedId = id;
        _userPicked = true;
        _autoPicked = null;
        _error = null;
      });

  Future<void> _addAddress() async {
    final loc = ref.read(locationProvider);
    // A GPS or map fix is a good first guess for the pin; a saved address or
    // the city fallback is not.
    final seed = loc.isFallback || loc.addressId != null
        ? null
        : PickedPin(lat: loc.lat, lng: loc.lng, label: loc.label, sublabel: loc.sublabel);
    final saved = await showAddAddressSheet(context, ref, pin: seed);
    if (saved != null && mounted) _pick(saved.id);
  }

  Future<void> _changeAddress(List<SavedAddress> list, SavedAddress? selected) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _AddressPickerSheet(addresses: list, selectedId: selected?.id),
    );
    if (!mounted || choice == null) return;
    if (choice == _AddressPickerSheet.addNew) {
      await _addAddress();
    } else {
      _pick(choice);
    }
  }

  Future<void> _setPin(SavedAddress a) async {
    final loc = ref.read(locationProvider);
    final pin = await showMapPicker(
      context,
      lat: a.lat ?? (loc.isFallback ? null : loc.lat),
      lng: a.lng ?? (loc.isFallback ? null : loc.lng),
    );
    if (pin == null || !mounted) return;
    setState(() {
      _pinBusy = true;
      _error = null;
    });
    try {
      await ref.read(addressesProvider.notifier).updatePin(a.id, pin.lat, pin.lng);
      // Keep this address chosen through the reload.
      if (mounted) setState(() => _selectedId = a.id);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } catch (_) {
      if (mounted) showSnack(context, 'Could not save pin to your address.');
    } finally {
      if (mounted) setState(() => _pinBusy = false);
    }
  }

  String get _detailsSummary => [
        _apartment.text,
        if (_floor.text.trim().isNotEmpty) 'Floor ${_floor.text.trim()}',
        _building.text,
        if (_entry.text.trim().isNotEmpty) 'Gate ${_entry.text.trim()}',
        _note.text,
      ].map((s) => s.trim()).where((s) => s.isNotEmpty).join(', ');

  String _fullLine(SavedAddress a) => deliveryAddressLine(
        a.line,
        apartment: _apartment.text,
        entry: _entry.text,
        floor: _floor.text,
        building: _building.text,
      );

  Future<void> _editDetails() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _DetailsSheet(
        apartment: _apartment,
        entry: _entry,
        floor: _floor,
        building: _building,
        note: _note,
      ),
    );
    if (mounted) setState(() {});
  }

  // ---------------------------------------------------------------- coupon

  String _couponMessage(String reason, Object? minOrder) {
    if (reason == 'min_order' && minOrder is num && minOrder > 0) {
      return 'Spend ${rupees(minOrder)} on food to use this code.';
    }
    return couponError(reason);
  }

  Future<void> _applyCoupon(String slug, int subtotal) async {
    final code = _couponCtrl.text.trim().toUpperCase();
    if (code.isEmpty || _couponBusy) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _couponBusy = true;
      _couponError = null;
    });
    try {
      final r = await ref.read(checkoutRepoProvider).validateCoupon(code, subtotal, slug);
      if (!mounted) return;
      final cart = ref.read(cartProvider);
      if (cart.subtotal != subtotal || cart.slug != slug) {
        setState(() => _couponError = 'Your basket changed — apply the code again.');
        return;
      }
      _couponCtrl.clear();
      setState(() => _coupon = _Coupon(r.code, r.discount, subtotal, slug));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _couponError = _couponReasons.contains(e.code)
          ? _couponMessage(e.code, e.body['minOrder'])
          : e.friendly);
    } catch (_) {
      if (mounted) setState(() => _couponError = 'Couldn\'t check that code. Try again.');
    } finally {
      if (mounted) setState(() => _couponBusy = false);
    }
  }

  // ---------------------------------------------------------------- payment

  void _ensureRules(String slug) {
    if (_rulesFor == slug) return;
    _rulesFor = slug;
    _rules = null;
    ref.read(checkoutRepoProvider).paymentRules(slug).then((r) {
      if (mounted && _rulesFor == slug) setState(() => _rules = r);
    });
  }

  Razorpay _gateway() => _razorpay ??= Razorpay()
    ..on(Razorpay.EVENT_PAYMENT_SUCCESS, _onPaySuccess)
    ..on(Razorpay.EVENT_PAYMENT_ERROR, _onPayError)
    ..on(Razorpay.EVENT_EXTERNAL_WALLET, _onPayWallet);

  void _settle(_PayOutcome o) {
    final p = _payment;
    if (p != null && !p.isCompleted) p.complete(o);
  }

  void _onPaySuccess(PaymentSuccessResponse r) => _settle(_PayOutcome.paid(r));
  void _onPayError(PaymentFailureResponse r) =>
      _settle(_PayOutcome.failed(cancelled: r.code == Razorpay.PAYMENT_CANCELLED));
  void _onPayWallet(ExternalWalletResponse r) => _settle(_PayOutcome.wallet(r.walletName));

  /// Collects the money for an order that already exists. Returns null once
  /// the server has verified the payment, else what to tell the customer —
  /// the order stays saved and unpaid either way.
  Future<String?> _collectPayment(Order order, String? restaurantName) async {
    final checkout = ref.read(checkoutRepoProvider);
    final ({String keyId, String providerOrderId, int amountPaise}) handoff;
    try {
      handoff = await checkout.razorpayOrder(order.id);
    } on ApiException catch (e) {
      return e.code == 'payments_unavailable' || e.code == 'online_payments_unavailable'
          ? 'Online payment isn\'t available right now. Your order is saved and waiting for payment — you can pay from the order page.'
          : 'Couldn\'t start the payment. Your order is saved and waiting for payment — you can retry from the order page.';
    } catch (_) {
      return 'Couldn\'t start the payment. Your order is saved and waiting for payment — you can retry from the order page.';
    }

    final phone = ref.read(profileProvider).value?.phone;
    _payment = Completer<_PayOutcome>();
    try {
      _gateway().open({
        'key': handoff.keyId,
        'amount': handoff.amountPaise,
        'currency': 'INR',
        'order_id': handoff.providerOrderId,
        'name': 'Deligro',
        'description': restaurantName == null
            ? 'Order ${order.shortId}'
            : '$restaurantName · Order ${order.shortId}',
        'prefill': {if (phone != null && phone.isNotEmpty) 'contact': phone},
        'theme': {'color': '#F2660C'},
      });
    } catch (_) {
      _settle(const _PayOutcome.failed());
    }
    final outcome = await _payment!.future;
    _payment = null;

    final ok = outcome.success;
    if (ok != null) {
      try {
        await checkout.razorpayVerify(
          orderId: order.id,
          razorpayOrderId: ok.orderId ?? handoff.providerOrderId,
          razorpayPaymentId: ok.paymentId ?? '',
          signature: ok.signature ?? '',
        );
        return null;
      } catch (_) {
        // Razorpay's webhook is the authority and will settle it.
        return 'We couldn\'t confirm the payment yet. If you were charged, your order will update shortly.';
      }
    }
    if (outcome.wallet != null) {
      return 'Finish paying in ${outcome.wallet}. Your order will update once the payment arrives.';
    }
    return outcome.cancelled
        ? 'Payment cancelled — your order is saved and waiting for payment. You can pay from the order page.'
        : 'The payment didn\'t go through. Your order is saved and waiting for payment — you can retry from the order page.';
  }

  // ---------------------------------------------------------------- submit

  static String _uuidV4() {
    final rnd = Random.secure();
    final b = List<int>.generate(16, (_) => rnd.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
        '${h.substring(16, 20)}-${h.substring(20)}';
  }

  String _placeError(ApiException e) {
    if (e.message != null) return e.message!;
    return switch (e.code) {
      'invalid_items' => 'Something in your cart is no longer available.',
      'tip_unsupported' =>
        'Tipping isn\'t available right now — set the tip to “No tip” to place your order.',
      'online_payments_unavailable' =>
        'Online payment isn\'t available yet — switch to Cash on delivery to place your order.',
      'instructions_too_long' =>
        'Your delivery instructions are too long — keep them under $maxDeliveryInstructions characters.',
      'network' => 'Network error — check your connection and try again.',
      _ => e.friendly,
    };
  }

  Future<void> _place({
    required CartState cart,
    required SavedAddress address,
    required bool payOnline,
  }) async {
    if (_phase != _Phase.ready) return;
    final slug = cart.slug!;
    setState(() {
      _phase = _Phase.placing;
      _error = null;
    });
    _idempotencyKey ??= _uuidV4();

    final Order order;
    try {
      order = await ref.read(orderRepoProvider).place(
            restaurantSlug: slug,
            lines: [
              for (final l in cart.lines) (itemId: l.itemId, qty: l.qty, variantId: l.variantId, addonIds: l.addonIds),
            ],
            addressLabel: address.label,
            addressLine: _fullLine(address),
            instructions: deliveryInstructions(_note.text),
            lat: address.lat,
            lng: address.lng,
            tip: _tip,
            paymentMethod: payOnline ? 'online' : 'cod',
            couponCode: _coupon?.code,
            idempotencyKey: _idempotencyKey!,
          );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _phase = _Phase.ready);
      if (e.unauthorized) {
        context.push('/login?next=/checkout');
        return;
      }
      if (e.code.startsWith('coupon_')) {
        // Re-priced at submit and refused (lapsed, or used up elsewhere).
        // Nothing was created; drop the code and say why.
        setState(() {
          _coupon = null;
          _couponError = _couponMessage(e.code.substring(7), e.body['minOrder']);
          _error = 'Your promo code was refused. Check the total and try again.';
        });
        return;
      }
      if (e.code == 'restaurant_closed' || e.code == 'restaurant_not_found') {
        ref.invalidate(restaurantProvider(slug));
      }
      setState(() => _error = _placeError(e));
      return;
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.ready;
        _error = 'Network error — check your connection and try again.';
      });
      return;
    }

    // The order exists now, paid or not.
    ref.invalidate(activeOrderProvider);
    ref.invalidate(myOrdersProvider);

    String? note;
    if (payOnline) {
      if (mounted) setState(() => _phase = _Phase.paying);
      note = await _collectPayment(order, cart.restaurantName);
    }
    if (!mounted) return;

    setState(() => _phase = _Phase.done);
    // Cleared on both paths: the basket is now an order, and keeping it would
    // invite a second one from a fresh checkout.
    ref.read(cartProvider.notifier).clear();
    if (note != null) {
      ref.invalidate(activeOrderProvider);
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Payment not completed'),
          content: Text(note!),
          actions: [
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('View order')),
          ],
        ),
      );
      if (!mounted) return;
    }
    context.go('/orders/${order.id}?placed=1');
  }

  Future<void> _clearBasket() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear your basket?'),
        content: const Text('Everything in it will be removed.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Clear')),
        ],
      ),
    );
    if (ok == true && mounted) ref.read(cartProvider.notifier).clear();
  }

  // ---------------------------------------------------------------- build

  String _outOfRange(Serviceability s, double fallbackRadius) {
    final r = s.radiusKm ?? fallbackRadius;
    final radius = r == r.roundToDouble() ? '${r.round()}' : r.toStringAsFixed(1);
    if (s.status == 'unverifiable') {
      return 'Put your delivery address on the map first (drop a pin or tap "Use my location"), '
          'so we can check we deliver there.';
    }
    if (s.reason == 'shop_outside_area') {
      return 'This shop is outside our $radius km Bemetara delivery area, so it can\'t deliver to you. '
          'Please pick another shop.';
    }
    final d = s.distanceKm;
    return d == null
        ? 'Sorry, we deliver only within $radius km of Bemetara.'
        : 'Sorry, we deliver only within $radius km of Bemetara — this address is about '
            '${(d * 10).round() / 10} km away.';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final cart = ref.watch(cartProvider);

    if (_phase == _Phase.done) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (cart.isEmpty || cart.slug == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Checkout')),
        body: EmptyState(
          icon: Icons.shopping_bag_outlined,
          title: 'Your cart is empty',
          body: 'Add a few dishes and they\'ll show up here, ready to check out.',
          action: 'Browse restaurants',
          onAction: () => context.go('/'),
        ),
      );
    }

    final slug = cart.slug!;
    final settings = ref.watch(settingsProvider).value ?? PlatformSettings.defaults;
    final restaurant = ref.watch(restaurantProvider(slug));
    final loc = ref.watch(locationProvider);
    final addressesAsync = ref.watch(addressesProvider);
    final addresses = addressesAsync.value;
    final selected = addresses == null ? null : _resolve(addresses, loc);

    _ensureRules(slug);
    if (selected != null) _ensureArea(slug, selected);

    // ---- money ----
    final subtotal = cart.subtotal;
    final coupon = _coupon != null && _coupon!.pricedAt == subtotal && _coupon!.slug == slug ? _coupon : null;
    final discount = coupon?.discount ?? 0;
    final charges = computeCharges(settings.charges, subtotal, tip: _tip, discount: discount);
    final total = charges.total;

    // ---- payment ----
    final rules = _rules ?? PaymentRules(true, settings.featureOnlinePayment, 0);
    final avail = _Availability(rules, settings.featureOnlinePayment, total);
    // The selection is a request; this is what it resolves to.
    final payOnline = avail.online && (!avail.cod || _method == 'online');

    // ---- area ----
    final areaKey = selected != null && selected.pinned ? _areaKey(slug, selected) : null;
    final measured = areaKey != null && _areas.containsKey(areaKey);
    final area = measured ? _areas[areaKey] : null;
    final outOfArea = area != null && area.blocks;
    final areaPending = areaKey != null && !measured;
    final unpinned = selected != null && !selected.pinned;

    // ---- guards ----
    final r = restaurant.value;
    final shopGone = restaurant.hasValue && r == null;
    final shopClosed = r != null && !r.open;
    final belowMin = settings.minOrder > 0 && subtotal < settings.minOrder;
    final addressesLoading = addresses == null && addressesAsync.isLoading;

    String? blockReason;
    String? blockLabel;
    if (!settings.acceptingOrders) {
      blockReason = settings.maintenanceMessage.trim().isNotEmpty
          ? settings.maintenanceMessage.trim()
          : 'We\'re not accepting orders right now.';
      blockLabel = 'Orders paused';
    } else if (shopGone) {
      blockReason = 'This restaurant is no longer available.';
      blockLabel = 'Restaurant unavailable';
    } else if (shopClosed) {
      blockReason = '${r.name} is closed right now. Try again when it opens.';
      blockLabel = 'Restaurant closed';
    } else if (belowMin) {
      blockReason =
          'Add ${rupees(settings.minOrder - subtotal)} more to reach the ${rupees(settings.minOrder)} minimum.';
    } else if (avail.noMethod) {
      blockReason = 'This shop cannot take payment right now.';
    } else if (addressesLoading) {
      blockLabel = 'Loading your addresses…';
    } else if (selected == null) {
      blockReason = 'Add a delivery address to continue.';
    } else if (unpinned) {
      blockReason = 'Set your address on the map to order.';
    } else if (outOfArea) {
      blockReason = 'We don\'t deliver to this address.';
      blockLabel = 'Outside delivery area';
    } else if (areaPending) {
      blockLabel = 'Checking delivery area…';
    }
    final blocked = blockReason != null || blockLabel != null;
    final busy = _phase != _Phase.ready;

    return PopScope(
      canPop: !busy,
      child: Scaffold(
        appBar: AppBar(
          title: Text(cart.restaurantName ?? 'Checkout', maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: 'Clear basket',
              onPressed: busy ? null : _clearBasket,
              icon: const Icon(Icons.delete_outline_rounded),
            ),
            const SizedBox(width: 4),
          ],
        ),
        body: GestureDetector(
          onTap: () => FocusScope.of(context).unfocus(),
          behavior: HitTestBehavior.translucent,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            children: [
              _section(
                title: 'Deliver to',
                trailing: addresses != null && addresses.isNotEmpty
                    ? TextButton(
                        onPressed: busy ? null : () => _changeAddress(addresses, selected),
                        child: const Text('Change'),
                      )
                    : null,
                child: _addressBody(
                  addressesAsync: addressesAsync,
                  selected: selected,
                  area: area,
                  outOfArea: outOfArea,
                  areaPending: areaPending,
                  radius: settings.deliveryRadiusKm,
                  busy: busy,
                ),
              ),
              const SizedBox(height: 12),
              _section(
                title: 'Your order',
                trailing: TextButton.icon(
                  onPressed: busy ? null : () => context.push('/restaurant/$slug'),
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('Add more items'),
                ),
                child: Column(
                  children: [
                    for (final l in cart.lines) _LineRow(line: l, enabled: !busy),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _tipSection(busy),
              const SizedBox(height: 12),
              _couponSection(slug, subtotal, coupon, busy),
              const SizedBox(height: 12),
              _paymentSection(avail, payOnline, settings.featureOnlinePayment, busy),
              const SizedBox(height: 12),
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Bill details', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 10),
                    BillRow('Subtotal', rupees(charges.subtotal)),
                    BillRow(
                      'Delivery',
                      charges.deliveryFee == 0 ? 'Free' : rupees(charges.deliveryFee),
                      highlight: charges.deliveryFee == 0,
                    ),
                    BillRow('Taxes', rupees(charges.taxes)),
                    if (charges.tip > 0) BillRow('Courier tip', rupees(charges.tip)),
                    if (discount > 0)
                      BillRow('Discount · ${coupon!.code}', rupees(discount), negative: true),
                    if (settings.charges.freeDeliveryThreshold > 0 && charges.deliveryFee > 0)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(
                          'Add ${rupees(settings.charges.freeDeliveryThreshold - subtotal)} more for free delivery',
                          style: TextStyle(color: c.green, fontWeight: FontWeight.w700, fontSize: 13),
                        ),
                      ),
                    const Divider(height: 22),
                    BillRow('Total', rupees(total), bold: true),
                    const SizedBox(height: 8),
                    Text('Final amount confirmed when you place the order.',
                        style: TextStyle(color: c.muted, fontSize: 12.5)),
                  ],
                ),
              ),
            ],
          ),
        ),
        bottomNavigationBar: _Dock(
          total: total,
          payOnline: payOnline,
          phase: _phase,
          blockReason: blockReason,
          blockLabel: blockLabel,
          error: _error,
          addressLabel: selected?.label,
          onPlace: blocked || busy || selected == null
              ? null
              : () => _place(cart: cart, address: selected, payOnline: payOnline),
        ),
      ),
    );
  }

  Widget _section({required String title, Widget? trailing, required Widget child}) => Panel(
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 48,
              child: Row(
                children: [
                  Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
                  ?trailing,
                ],
              ),
            ),
            Padding(padding: const EdgeInsets.only(right: 8), child: child),
          ],
        ),
      );

  Widget _addressBody({
    required AsyncValue<List<SavedAddress>> addressesAsync,
    required SavedAddress? selected,
    required Serviceability? area,
    required bool outOfArea,
    required bool areaPending,
    required double radius,
    required bool busy,
  }) {
    final c = context.colors;
    final list = addressesAsync.value;
    if (list == null) {
      if (addressesAsync.hasError) {
        return Row(
          children: [
            Expanded(
              child: Text('Couldn\'t load your addresses.', style: TextStyle(color: c.muted)),
            ),
            TextButton(onPressed: () => ref.invalidate(addressesProvider), child: const Text('Try again')),
          ],
        );
      }
      return Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(12)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(width: 90, height: 14, color: c.surface2),
                const SizedBox(height: 6),
                Container(width: 200, height: 12, color: c.surface2),
              ],
            ),
          ),
        ],
      );
    }
    if (selected == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Set delivery address', style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text('Pin it on the map and add your house or flat number.',
              style: TextStyle(color: c.muted, fontSize: 13)),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: busy ? null : _addAddress,
            icon: const Icon(Icons.add_location_alt_rounded),
            label: const Text('Add address'),
          ),
        ],
      );
    }
    final details = _detailsSummary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_autoPicked != null && !outOfArea)
          _Notice(
            tone: _Tone.good,
            text: 'Your default address is outside this shop\'s delivery area, so we picked your saved '
                '“$_autoPicked” address. Tap Change to pick another.',
          ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(12)),
              child: Icon(Icons.location_on_rounded, color: c.accentInk),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(selected.label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 2),
                  Text(selected.line,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: c.muted, height: 1.3)),
                  if (areaPending) ...[
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 1.6, color: c.muted),
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text('Checking we deliver here…',
                              style: TextStyle(fontSize: 12.5, color: c.muted)),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
        if (outOfArea && area != null)
          _Notice(tone: _Tone.bad, text: _outOfRange(area, radius)),
        if (!selected.pinned)
          _Notice(
            tone: _Tone.bad,
            text: 'This address is not on the map yet, so we can\'t check we deliver there.',
            action: _pinBusy ? null : 'Pin on map',
            busy: _pinBusy,
            onAction: busy ? null : () => _setPin(selected),
          )
        else
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: busy || _pinBusy ? null : () => _setPin(selected),
              icon: _pinBusy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.edit_location_alt_outlined, size: 18),
              label: const Text('Adjust pin'),
            ),
          ),
        const Divider(height: 14),
        InkWell(
          onTap: busy ? null : _editDetails,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Icon(Icons.edit_note_rounded, color: c.accentInk),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Delivery instructions', style: TextStyle(fontWeight: FontWeight.w700)),
                      Text(
                        details.isEmpty ? 'Flat, floor, landmark. Optional.' : details,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: c.muted),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: c.muted),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _tipSection(bool busy) {
    final c = context.colors;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(16)),
                child: Icon(Icons.pedal_bike_rounded, size: 28, color: c.accentInk),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Tip the courier?', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 2),
                    Text('100% goes to your courier.', style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in tipOptions)
                ChoiceChip(
                  showCheckmark: false,
                  materialTapTargetSize: MaterialTapTargetSize.padded,
                  label: ConstrainedBox(
                    constraints: const BoxConstraints(minWidth: 52),
                    child: Text(t == 0 ? 'No tip' : rupees(t), textAlign: TextAlign.center),
                  ),
                  selected: _tip == t,
                  onSelected: busy ? null : (_) => setState(() => _tip = t),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _couponSection(String slug, int subtotal, _Coupon? coupon, bool busy) {
    final c = context.colors;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Have a code?', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 10),
          if (coupon != null)
            Container(
              padding: const EdgeInsets.fromLTRB(14, 8, 4, 8),
              decoration: BoxDecoration(color: c.greenSoft, borderRadius: BorderRadius.circular(12)),
              child: Row(
                children: [
                  Icon(Icons.local_offer_rounded, color: c.green, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(coupon.code,
                            style: dataStyle(context, size: 14, weight: FontWeight.w800).copyWith(color: c.green)),
                        Text('${rupees(coupon.discount)} off your food',
                            style: TextStyle(fontSize: 12.5, color: c.muted)),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => setState(() {
                              _coupon = null;
                              _couponError = null;
                            }),
                    child: const Text('Remove'),
                  ),
                ],
              ),
            )
          else
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _couponCtrl,
                    enabled: !busy,
                    textCapitalization: TextCapitalization.characters,
                    autocorrect: false,
                    enableSuggestions: false,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _applyCoupon(slug, subtotal),
                    style: dataStyle(context, size: 15, weight: FontWeight.w600),
                    decoration: InputDecoration(
                      hintText: 'Promo code',
                      fillColor: c.surface2,
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                SizedBox(
                  height: 48,
                  child: OutlinedButton(
                    onPressed: busy || _couponBusy || _couponCtrl.text.trim().isEmpty
                        ? null
                        : () => _applyCoupon(slug, subtotal),
                    child: _couponBusy
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Apply'),
                  ),
                ),
              ],
            ),
          if (_couponError != null) ...[
            const SizedBox(height: 8),
            Text(_couponError!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13.5)),
          ],
        ],
      ),
    );
  }

  Widget _paymentSection(_Availability avail, bool payOnline, bool platformOnline, bool busy) {
    final c = context.colors;
    final codHint = avail.limit > 0 && !avail.codOff && !avail.overLimit
        ? 'Cash on delivery is available up to ${rupees(avail.limit)}.'
        : null;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Payment', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 2),
          Text(avail.summary, style: TextStyle(color: c.muted, fontSize: 13)),
          const SizedBox(height: 12),
          if (avail.notice != null) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(12)),
              child: Text(avail.notice!,
                  style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w600, fontSize: 13)),
            ),
            const SizedBox(height: 10),
          ],
          _PayOption(
            icon: Icons.payments_outlined,
            label: 'Cash on delivery',
            desc: avail.overLimit
                ? 'Not available for this amount.'
                : (codHint ?? 'Pay the courier when your order arrives.'),
            selected: avail.cod && !payOnline,
            disabled: !avail.cod || busy,
            badge: avail.overLimit
                ? 'Over cash limit'
                : avail.codOff
                    ? 'Not accepted'
                    : null,
            onTap: () => setState(() => _method = 'cod'),
          ),
          const SizedBox(height: 8),
          _PayOption(
            icon: Icons.credit_card_rounded,
            label: 'Pay online (UPI, cards)',
            desc: 'UPI, cards, netbanking and wallets.',
            selected: payOnline,
            disabled: !avail.online || busy,
            badge: avail.online ? null : (platformOnline ? 'Not accepted' : 'Available soon'),
            onTap: () => setState(() => _method = 'online'),
          ),
        ],
      ),
    );
  }
}

// ------------------------------------------------------------------ widgets

class _LineRow extends ConsumerWidget {
  const _LineRow({required this.line, required this.enabled});
  final CartLine line;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final cart = ref.read(cartProvider.notifier);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          VegMark(line.veg),
          if (line.veg != null) const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(line.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                if (line.options.isNotEmpty) Text(line.options, style: TextStyle(color: c.muted, fontSize: 12.5)),
                Text(rupees(line.price), style: dataStyle(context, size: 12.5, weight: FontWeight.w500).copyWith(color: c.muted)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          IgnorePointer(
            ignoring: !enabled,
            child: QtyStepper(
              compact: true,
              qty: line.qty,
              onAdd: () => cart.increment(line.key),
              onRemove: () => cart.decrement(line.key),
            ),
          ),
          SizedBox(
            width: 66,
            child: Text(rupees(line.price * line.qty),
                textAlign: TextAlign.right, style: dataStyle(context, weight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

enum _Tone { good, bad }

class _Notice extends StatelessWidget {
  const _Notice({required this.tone, required this.text, this.action, this.onAction, this.busy = false});
  final _Tone tone;
  final String text;
  final String? action;
  final VoidCallback? onAction;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final good = tone == _Tone.good;
    final fg = good ? c.green : c.deal;
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 4),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: good ? c.greenSoft : c.dealSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(good ? Icons.place_rounded : Icons.warning_amber_rounded, size: 18, color: fg),
              const SizedBox(width: 8),
              Expanded(
                child: Text(text,
                    style: TextStyle(fontSize: 13.5, height: 1.35, fontWeight: FontWeight.w600, color: good ? c.ink : fg)),
              ),
            ],
          ),
          if (action != null || busy) ...[
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.only(left: 26),
              child: busy
                  ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
                  : FilledButton.icon(
                      onPressed: onAction,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(44, 44),
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800),
                      ),
                      icon: const Icon(Icons.add_location_alt_rounded, size: 18),
                      label: Text(action!),
                    ),
            ),
          ],
        ],
      ),
    );
  }
}

class _PayOption extends StatelessWidget {
  const _PayOption({
    required this.icon,
    required this.label,
    required this.desc,
    required this.selected,
    required this.disabled,
    required this.onTap,
    this.badge,
  });

  final IconData icon;
  final String label;
  final String desc;
  final bool selected;
  final bool disabled;
  final String? badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final on = selected && !disabled;
    return Semantics(
      inMutuallyExclusiveGroup: true,
      checked: on,
      enabled: !disabled,
      child: Opacity(
        opacity: disabled && !selected ? .6 : 1,
        child: Material(
          color: on ? c.accentSoft : c.surface2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: on ? c.accent : c.line, width: on ? 1.4 : 1),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: disabled ? null : onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icon, color: on ? c.accentInk : c.muted),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(label, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                            if (badge != null)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                decoration: BoxDecoration(
                                  color: c.surface,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Text(badge!.toUpperCase(),
                                    style: TextStyle(
                                        fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: .5, color: c.muted)),
                              ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(desc, style: TextStyle(fontSize: 12.5, color: c.muted)),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    width: 20,
                    height: 20,
                    margin: const EdgeInsets.only(top: 2),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: on ? c.accent : c.line, width: 2),
                    ),
                    alignment: Alignment.center,
                    child: on
                        ? Container(
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
                          )
                        : null,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Dock extends StatelessWidget {
  const _Dock({
    required this.total,
    required this.payOnline,
    required this.phase,
    required this.blockReason,
    required this.blockLabel,
    required this.error,
    required this.addressLabel,
    required this.onPlace,
  });

  final int total;
  final bool payOnline;
  final _Phase phase;
  final String? blockReason;
  final String? blockLabel;
  final String? error;
  final String? addressLabel;
  final VoidCallback? onPlace;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final working = phase == _Phase.placing || phase == _Phase.paying;
    final pendingLabel = blockLabel != null && blockReason == null;

    final Widget label;
    if (working) {
      label = Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4, color: c.muted)),
          const SizedBox(width: 10),
          Text(phase == _Phase.paying ? 'Waiting for payment…' : 'Placing order…'),
        ],
      );
    } else if (blockLabel != null) {
      label = Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (pendingLabel) ...[
            SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2, color: c.muted)),
            const SizedBox(width: 10),
          ],
          Flexible(child: Text(blockLabel!, overflow: TextOverflow.ellipsis)),
        ],
      );
    } else {
      label = Text('${payOnline ? 'Pay & place order' : 'Place order'} · ${rupees(total)}');
    }

    return Material(
      color: c.surface,
      elevation: 0,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(top: BorderSide(color: c.line))),
        child: SafeArea(
          top: false,
          minimum: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(error!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13.5)),
                  ),
                )
              else if (blockReason != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.info_outline_rounded, size: 16, color: c.deal),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(blockReason!,
                            textAlign: TextAlign.center,
                            style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13.5)),
                      ),
                    ],
                  ),
                )
              else
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          [
                            payOnline ? 'Paying online' : 'Cash on delivery',
                            if (addressLabel != null) 'to $addressLabel',
                          ].join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: c.muted, fontSize: 13),
                        ),
                      ),
                      Text('To pay ', style: TextStyle(color: c.muted, fontSize: 13)),
                      Text(rupees(total), style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                    ],
                  ),
                ),
              FilledButton(
                onPressed: working ? null : onPlace,
                style: FilledButton.styleFrom(shape: const StadiumBorder()),
                child: label,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AddressPickerSheet extends StatelessWidget {
  const _AddressPickerSheet({required this.addresses, required this.selectedId});
  final List<SavedAddress> addresses;
  final String? selectedId;

  static const addNew = '__add__';

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: .6,
      maxChildSize: .9,
      minChildSize: .3,
      builder: (context, scroll) => ListView(
        controller: scroll,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        children: [
          Text('Deliver to', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 10),
          for (final a in addresses)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: a.id == selectedId ? c.accentSoft : c.surface2,
                borderRadius: BorderRadius.circular(radiusBlock),
                child: InkWell(
                  borderRadius: BorderRadius.circular(radiusBlock),
                  onTap: () => Navigator.pop(context, a.id),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(
                          a.id == selectedId ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded,
                          color: a.id == selectedId ? c.accent : c.muted,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Wrap(
                                spacing: 6,
                                runSpacing: 4,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Text(a.label, style: const TextStyle(fontWeight: FontWeight.w800)),
                                  if (a.isDefault)
                                    Text('DEFAULT',
                                        style: TextStyle(
                                            fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: .5, color: c.muted)),
                                  if (!a.pinned)
                                    Text('NOT ON MAP',
                                        style: TextStyle(
                                            fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: .5, color: c.deal)),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(a.line, style: TextStyle(fontSize: 13, color: c.muted, height: 1.3)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 4),
          OutlinedButton.icon(
            onPressed: () => Navigator.pop(context, addNew),
            icon: const Icon(Icons.add_rounded),
            label: const Text('Add new address'),
          ),
        ],
      ),
    );
  }
}

class _DetailsSheet extends StatelessWidget {
  const _DetailsSheet({
    required this.apartment,
    required this.entry,
    required this.floor,
    required this.building,
    required this.note,
  });

  final TextEditingController apartment;
  final TextEditingController entry;
  final TextEditingController floor;
  final TextEditingController building;
  final TextEditingController note;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Delivery instructions', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('All optional. Flat, floor and gate are added to your address; your note goes to the courier.',
                style: TextStyle(color: context.colors.muted, fontSize: 13)),
            const SizedBox(height: 16),
            TextField(
              controller: apartment,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(labelText: 'Apartment, flat or suite number'),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: entry,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(labelText: 'Entry code'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: floor,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(labelText: 'Floor'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: building,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(labelText: 'Building name'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: note,
              textInputAction: TextInputAction.done,
              textCapitalization: TextCapitalization.sentences,
              maxLength: maxDeliveryInstructions,
              decoration: const InputDecoration(labelText: 'Instructions for the courier'),
            ),
            TextButton(
              onPressed: () {
                Navigator.pop(context);
                context.push('/profile/addresses');
              },
              child: const Text('Manage saved addresses'),
            ),
            const SizedBox(height: 4),
            FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Done')),
          ],
        ),
      ),
    );
  }
}
