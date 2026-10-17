import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/address.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../location/address_form.dart';
import '../location/map_picker.dart';

/// Saved addresses (app/(customer)/profile/addresses): default badge, set
/// default, pin on map, remove, add.
class AddressesScreen extends ConsumerStatefulWidget {
  const AddressesScreen({super.key});

  @override
  ConsumerState<AddressesScreen> createState() => _AddressesScreenState();
}

class _AddressesScreenState extends ConsumerState<AddressesScreen> {
  String? _busyId;

  Future<void> _run(String id, Future<void> Function() task, String fallback) async {
    setState(() => _busyId = id);
    try {
      await task();
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } catch (_) {
      if (mounted) showSnack(context, fallback);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _add() async {
    final saved = await showAddAddressSheet(context, ref);
    if (saved != null && mounted) showSnack(context, 'Address saved.');
  }

  Future<void> _pin(SavedAddress a) async {
    final loc = ref.read(locationProvider);
    final pin = await showMapPicker(
      context,
      lat: a.lat ?? loc.lat,
      lng: a.lng ?? loc.lng,
    );
    if (pin == null || !mounted) return;
    await _run(
      a.id,
      () => ref.read(addressesProvider.notifier).updatePin(a.id, pin.lat, pin.lng),
      'Could not save the pin. Try again.',
    );
  }

  Future<void> _remove(SavedAddress a, int total) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final c = ctx.colors;
        return AlertDialog(
          title: const Text('Remove this address?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(a.line),
              if (a.isDefault && total > 1) ...[
                const SizedBox(height: 10),
                Text('It is your default — the next address will take over.',
                    style: TextStyle(color: c.muted)),
              ],
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: c.deal, foregroundColor: Colors.white),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove'),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;
    await _run(
      a.id,
      () async {
        await ref.read(addressesProvider.notifier).remove(a.id);
        // The header should not keep pointing at an address that's gone.
        final loc = ref.read(locationProvider);
        if (loc.addressId == a.id) {
          ref.read(locationProvider.notifier).set(DeliveryLocation(
                lat: loc.lat,
                lng: loc.lng,
                label: loc.label,
                sublabel: loc.sublabel,
              ));
        }
      },
      'Could not remove the address. Try again.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final addresses = ref.watch(addressesProvider);
    final hasAny = (addresses.value ?? const []).isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Saved addresses'),
        actions: [
          IconButton(
            tooltip: 'Add address',
            onPressed: _add,
            icon: const Icon(Icons.add_rounded),
          ),
          const SizedBox(width: 4),
        ],
      ),
      floatingActionButton: hasAny
          ? FloatingActionButton.extended(
              onPressed: _add,
              icon: const Icon(Icons.add_location_alt_rounded),
              label: const Text('Add address', style: TextStyle(fontWeight: FontWeight.w800)),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: () => refreshAll(ref, [addressesProvider]),
        child: AsyncBody<List<SavedAddress>>(
          value: addresses,
          onRetry: () => ref.invalidate(addressesProvider),
          loading: const _Skeleton(),
          builder: (list) {
            if (list.isEmpty) {
              return LayoutBuilder(
                builder: (context, box) => SingleChildScrollView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  child: SizedBox(
                    height: box.maxHeight,
                    child: EmptyState(
                      icon: Icons.location_on_outlined,
                      title: 'No saved addresses',
                      body: 'Add where we should deliver your orders.',
                      action: 'Add address',
                      onAction: _add,
                    ),
                  ),
                ),
              );
            }
            return ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (_, i) {
                final a = list[i];
                return _AddressCard(
                  address: a,
                  busy: _busyId == a.id,
                  locked: _busyId != null,
                  onSetDefault: () => _run(
                    a.id,
                    () => ref.read(addressesProvider.notifier).setDefault(a.id),
                    'Could not change your default. Try again.',
                  ),
                  onPin: () => _pin(a),
                  onRemove: () => _remove(a, list.length),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

class _AddressCard extends StatelessWidget {
  const _AddressCard({
    required this.address,
    required this.busy,
    required this.locked,
    required this.onSetDefault,
    required this.onPin,
    required this.onRemove,
  });

  final SavedAddress address;
  final bool busy;
  final bool locked;
  final VoidCallback onSetDefault;
  final VoidCallback onPin;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final a = address;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: c.blue.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: busy
                    ? Padding(
                        padding: const EdgeInsets.all(12),
                        child: CircularProgressIndicator(strokeWidth: 2, color: c.blue),
                      )
                    : Icon(_iconFor(a.label), color: c.blue),
              ),
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
                        Text(a.label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                        if (a.isDefault) _Badge('Default', bg: c.accentSoft, fg: c.accentInk),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(a.line, style: TextStyle(color: c.muted, height: 1.35)),
                    if (!a.pinned) ...[
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Icon(Icons.error_outline_rounded, size: 16, color: c.deal),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text('Not on the map yet — pin it to order here.',
                                style: TextStyle(fontSize: 13, color: c.deal, fontWeight: FontWeight.w600)),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (!a.isDefault)
                _ActionChip(
                  icon: Icons.star_outline_rounded,
                  label: 'Set default',
                  onTap: locked ? null : onSetDefault,
                ),
              _ActionChip(
                icon: a.pinned ? Icons.edit_location_alt_outlined : Icons.add_location_alt_outlined,
                label: a.pinned ? 'Move pin' : 'Pin on map',
                color: a.pinned ? null : c.accentInk,
                onTap: locked ? null : onPin,
              ),
              _ActionChip(
                icon: Icons.delete_outline_rounded,
                label: 'Remove',
                color: c.deal,
                onTap: locked ? null : onRemove,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

IconData _iconFor(String label) => switch (label.toLowerCase()) {
      'home' => Icons.home_rounded,
      'work' => Icons.work_rounded,
      _ => Icons.location_on_rounded,
    };

class _ActionChip extends StatelessWidget {
  const _ActionChip({required this.icon, required this.label, required this.onTap, this.color});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fg = color ?? c.ink;
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 18, color: onTap == null ? c.muted : fg),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        foregroundColor: fg,
        textStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
        shape: const StadiumBorder(),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, {required this.bg, required this.fg});
  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text.toUpperCase(),
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: .5, color: fg)),
      );
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      children: [
        for (var i = 0; i < 3; i++)
          Container(
            height: 130,
            margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
          ),
      ],
    );
  }
}
