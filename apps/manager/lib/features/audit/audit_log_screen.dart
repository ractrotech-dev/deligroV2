import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/audit.dart';
import '../../state/audit.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import 'audit_filters_sheet.dart';

/// The audit log (§16): every recorded action in this manager's zones —
/// who did what to which record, when and why. Read only; nothing here can
/// change an entry.
class AuditLogScreen extends ConsumerStatefulWidget {
  const AuditLogScreen({super.key});

  @override
  ConsumerState<AuditLogScreen> createState() => _AuditLogScreenState();
}

class _AuditLogScreenState extends ConsumerState<AuditLogScreen> {
  AuditFilters _filters = const AuditFilters();
  final _scroll = ScrollController();
  AuditFilters? _effective;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      final eff = _effective;
      if (eff == null || !_scroll.hasClients) return;
      final p = _scroll.position;
      if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) {
        ref.read(auditListProvider(eff).notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.copyWith(zoneId: zone?.id);
    _effective = eff;
    final value = ref.watch(auditListProvider(eff));
    final catalog = ref.watch(auditActionsProvider).value ?? const <AuditActionDef>[];
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Audit log'),
        backgroundColor: c.bg,
        actions: [
          IconButton(
            key: const Key('audit-filters'),
            tooltip: 'Filters',
            onPressed: () async {
              final next = await showAuditFiltersSheet(context, current: eff);
              if (next != null && mounted) setState(() => _filters = next.copyWith(zoneId: null));
            },
            icon: Badge(
              isLabelVisible: _filters.count > 0,
              label: Text('${_filters.count}'),
              backgroundColor: c.accent,
              textColor: c.onAccent,
              child: const Icon(Icons.tune),
            ),
          ),
          const Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip()),
        ],
      ),
      body: Builder(builder: (context) {
        final data = value.value;
        if (data == null) {
          if (value.hasError) {
            final e = value.error!;
            if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
            return ErrorRetry(error: e, onRetry: () => ref.invalidate(auditListProvider(eff)));
          }
          return const Center(child: CircularProgressIndicator());
        }
        Future<void> pull() => ref.read(auditListProvider(eff).notifier).refresh();
        if (data.items.isEmpty) {
          return RefreshIndicator(
            onRefresh: pull,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [EmptyLine(_filters.count > 0 ? 'No entries match these filters.' : 'No recorded actions yet.')],
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: pull,
          child: ListView.separated(
            key: const Key('audit-list'),
            controller: _scroll,
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
            itemCount: data.items.length + (data.hasMore ? 1 : 0),
            separatorBuilder: (_, _) => Divider(height: 1, color: c.line),
            itemBuilder: (context, i) {
              if (i == data.items.length) {
                return Center(
                  child: TextButton(
                    onPressed: () => ref.read(auditListProvider(eff).notifier).loadMore(),
                    child: Text(data.loadMoreFailed ? "Couldn't load more — tap to retry" : 'Load more'),
                  ),
                );
              }
              return _Row(entry: data.items[i], catalog: catalog);
            },
          ),
        );
      }),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.entry, required this.catalog});
  final AuditEntry entry;
  final List<AuditActionDef> catalog;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final e = entry;
    return InkWell(
      key: Key('audit-${e.id}'),
      onTap: () => GoRouter.maybeOf(context)?.push('/more/audit/${e.id}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Expanded(
                child: Text(auditActionLabel(e.action, catalog),
                    style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
              ),
              Text(placedAt(e.at), style: TextStyle(color: c.muted, fontSize: 12)),
            ]),
            const SizedBox(height: 2),
            Text('${e.actor.name} · ${e.actor.roleLabel}', style: TextStyle(color: c.ink, fontSize: 13)),
            Text('${auditEntityLabel(e.entityType)} ${e.entityId}',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: dataStyle(context, size: 12).copyWith(color: c.muted)),
            if (e.reason != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text('"${e.reason}"', maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.ink, fontSize: 13)),
              ),
          ],
        ),
      ),
    );
  }
}

/// "restaurant" → "Vendor".
String auditEntityLabel(String type) => switch (type) {
      'order' => 'Order',
      'delivery' => 'Delivery',
      'restaurant' => 'Vendor',
      'rider' => 'Rider',
      'customer' => 'Customer',
      'menu_item' => 'Product',
      'ticket' => 'Ticket',
      'settlement' => 'Settlement',
      'payment_request' => 'Payment',
      'coupon' => 'Offer',
      'campaign' => 'Campaign',
      'marketing_request' => 'Marketing request',
      'alert_rule' => 'Alert threshold',
      'zone' => 'Zone',
      '' => 'Record',
      _ => type.replaceAll('_', ' '),
    };
