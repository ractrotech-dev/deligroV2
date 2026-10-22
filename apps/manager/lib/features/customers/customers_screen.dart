import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/customers.dart';
import '../../state/customers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/paged_list_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'customer_detail_screen.dart';
import 'customer_labels.dart';

/// Customers (§10.1–10.2): people who have ordered in this manager's zones.
/// Search by customer id or name; by phone only with the contact permission
/// (each phone search is recorded). Phones are masked everywhere.
class CustomersScreen extends ConsumerStatefulWidget {
  const CustomersScreen({super.key, this.query});
  final Uri? query;

  @override
  ConsumerState<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends ConsumerState<CustomersScreen> {
  CustomerFilters _filters = const CustomerFilters();
  Timer? _debounce;
  final _phone = TextEditingController();
  String? _selected;

  @override
  void dispose() {
    _debounce?.cancel();
    _phone.dispose();
    super.dispose();
  }

  void _searchPhone(String raw) {
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    final ten = digits.length > 10 ? digits.substring(digits.length - 10) : digits;
    if (ten.isEmpty) {
      setState(() => _filters = _filters.copyWith(phone: null));
      return;
    }
    if (ten.length != 10) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Enter a 10-digit mobile number.')));
      return;
    }
    setState(() => _filters = _filters.copyWith(phone: ten, q: null));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final canContact = me?.can('manager.customers.contact') ?? false;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    final value = ref.watch(customerListProvider(eff));

    final list = Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
        child: TextField(
          key: const Key('customers-search'),
          decoration: _box(c, 'Customer id or name', Icons.search),
          onChanged: (t) {
            _debounce?.cancel();
            _debounce = Timer(const Duration(milliseconds: 400), () {
              final q = t.trim();
              if (mounted) setState(() => _filters = _filters.copyWith(q: q.length < 2 ? null : q));
            });
          },
        ),
      ),
      if (canContact)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: TextField(
            key: const Key('customers-phone'),
            controller: _phone,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.search,
            decoration: _box(c, 'Mobile number (search is recorded)', Icons.phone_outlined),
            onSubmitted: _searchPhone,
          ),
        ),
      CountChips<CustomerStatus>(
        keyPrefix: 'customer-status',
        options: [for (final s in CustomerStatus.tabs) (s, s.label, null)],
        selected: _filters.status,
        allLabel: 'All',
        onSelected: (s) => setState(() => _filters = _filters.copyWith(status: s)),
      ),
      CountChips<CustomerSort>(
        keyPrefix: 'customer-sort',
        options: [for (final s in CustomerSort.values) (s, s.label, null)],
        selected: _filters.sort,
        onSelected: (s) => setState(() => _filters = _filters.copyWith(sort: s ?? CustomerSort.recent)),
      ),
      Expanded(
        child: PagedListView<CustomerSummary, void>(
          key: const Key('customers-list'),
          value: value,
          narrowed: _filters.narrowed,
          filteredEmptyText: 'No customers match.',
          onRetry: () => ref.invalidate(customerListProvider(eff)),
          onRefresh: () => ref.read(customerListProvider(eff).notifier).refresh(),
          onLoadMore: () => ref.read(customerListProvider(eff).notifier).loadMore(),
          empty: const EmptySection(
            icon: Icons.people_outline,
            title: 'No customers yet',
            text: 'People who order in your zones appear here.',
          ),
          itemBuilder: (context, x) => _CustomerRow(customer: x, selected: x.id == _selected, onTap: () => _open(x)),
        ),
      ),
    ]);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Customers'),
        backgroundColor: c.bg,
        actions: [
          IconButton(
            key: const Key('customers-retention'),
            tooltip: 'Retention',
            onPressed: () => GoRouter.maybeOf(context)?.push('/more/customers/retention'),
            icon: const Icon(Icons.insights_outlined),
          ),
          const Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip()),
        ],
      ),
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : LayoutBuilder(builder: (context, box) {
              if (box.maxWidth < 840) return list;
              return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                SizedBox(width: 420, child: list),
                VerticalDivider(width: 1, color: c.line),
                Expanded(
                  child: _selected == null
                      ? Center(child: Text('Pick a customer to see them here.', style: TextStyle(color: c.muted)))
                      : CustomerDetailBody(key: ValueKey(_selected), customerId: _selected!),
                ),
              ]);
            }),
    );
  }

  void _open(CustomerSummary x) {
    if (MediaQuery.sizeOf(context).width >= 840) {
      setState(() => _selected = x.id);
    } else {
      GoRouter.maybeOf(context)?.push('/more/customers/${x.id}');
    }
  }

  InputDecoration _box(AppColors c, String hint, IconData icon) => InputDecoration(
        isDense: true,
        prefixIcon: Icon(icon),
        hintText: hint,
        filled: true,
        fillColor: c.surface,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
      );
}

class _CustomerRow extends StatelessWidget {
  const _CustomerRow({required this.customer, required this.onTap, this.selected = false});
  final CustomerSummary customer;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final x = customer;
    return RowCard(
      key: Key('customer-row-${x.id}'),
      selected: selected,
      onTap: onTap,
      child: Row(children: [
        CircleAvatar(
          radius: 18,
          backgroundColor: c.accentSoft,
          child: Text(x.displayName.characters.first.toUpperCase(), style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w800)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(x.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
            const SizedBox(height: 2),
            Wrap(spacing: 10, children: [
              if (x.phoneMasked != null) Text(x.phoneMasked!, style: dataStyle(context, size: 12, weight: FontWeight.w500)),
              Text(x.shortId, style: TextStyle(fontSize: 12, color: c.muted)),
            ]),
            const SizedBox(height: 4),
            Wrap(spacing: 12, runSpacing: 2, children: [
              StatusText(x.status.label, color: customerStatusColor(c, x.status)),
              Text('${count(x.orders)} orders · ${rupees(x.spent)}', style: dataStyle(context, size: 12)),
              if (x.lastOrderAt != null) Text('Last ${placedAt(x.lastOrderAt)}', style: TextStyle(fontSize: 12, color: c.muted)),
            ]),
          ]),
        ),
      ]),
    );
  }
}
