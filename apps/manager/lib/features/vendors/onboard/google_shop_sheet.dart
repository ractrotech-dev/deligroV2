import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../models/vendors.dart';
import '../../../state/providers.dart';
import '../../../theme/app_theme.dart';

/// Find a shop on Google Maps. Closes with its address and pin, or with null
/// when the manager backs out. Nothing is saved here; the onboarding form takes
/// the values and they are checked when it is submitted.
Future<ShopPlace?> showGoogleShopSheet(BuildContext context, {String? shopName}) => showModalBottomSheet<ShopPlace>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _GoogleShopSheet(shopName: shopName),
    );

class _GoogleShopSheet extends ConsumerStatefulWidget {
  const _GoogleShopSheet({this.shopName});
  final String? shopName;

  @override
  ConsumerState<_GoogleShopSheet> createState() => _GoogleShopSheetState();
}

class _GoogleShopSheetState extends ConsumerState<_GoogleShopSheet> {
  late final _text = TextEditingController(text: widget.shopName ?? '');

  /// One search and its chosen result are one billable session at Google.
  final _session = const Uuid().v4();
  Timer? _debounce;
  int _latest = 0;
  bool _busy = false;
  String? _message;
  List<PlaceHit> _hits = const [];

  @override
  void initState() {
    super.initState();
    if (_text.text.trim().length >= 2) _search(_text.text);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () => _search(value));
  }

  Future<void> _search(String value) async {
    final q = value.trim();
    final turn = ++_latest;
    if (q.length < 2) {
      setState(() {
        _hits = const [];
        _message = null;
        _busy = false;
      });
      return;
    }
    setState(() => _busy = true);
    try {
      final hits = await ref.read(vendorsRepoProvider).searchPlaces(q, _session);
      if (!mounted || turn != _latest) return;
      setState(() {
        _hits = hits;
        _busy = false;
        _message = hits.isEmpty ? 'No match on Google Maps. Try the area too, or tap the map instead.' : null;
      });
    } catch (_) {
      if (!mounted || turn != _latest) return;
      setState(() {
        _hits = const [];
        _busy = false;
        _message = "Google Maps search isn't available. Type the address and tap the map instead.";
      });
    }
  }

  Future<void> _choose(PlaceHit hit) async {
    setState(() => _busy = true);
    try {
      final place = await ref.read(vendorsRepoProvider).placeDetails(hit.placeId, _session);
      if (mounted) Navigator.of(context).pop(place);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _message = "Couldn't read that shop from Google Maps. Try again.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                key: const Key('google-shop-search'),
                controller: _text,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: _onChanged,
                decoration: InputDecoration(
                  labelText: 'Shop name and area',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _busy
                      ? const Padding(
                          padding: EdgeInsets.all(14),
                          child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        )
                      : null,
                ),
              ),
              const SizedBox(height: 8),
              if (_message != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(_message!, style: TextStyle(color: c.muted, fontSize: 13)),
                ),
              Expanded(
                child: ListView(
                  children: [
                    for (final hit in _hits)
                      ListTile(
                        key: Key('google-shop-${hit.placeId}'),
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.storefront),
                        title: Text(hit.name),
                        subtitle: Text(hit.address),
                        onTap: _busy ? null : () => _choose(hit),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
