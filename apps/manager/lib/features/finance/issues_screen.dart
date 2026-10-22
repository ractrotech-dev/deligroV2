import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'finance_list.dart';

/// Where an issue's subject lives in this app, or null for one it can't open.
String? issueRoute(IssueSubject s) => switch (s.kind) {
      IssueSubjectKind.order => '/orders/${s.id}',
      IssueSubjectKind.vendor => '/more/vendors/${s.id}',
      IssueSubjectKind.settlement => '/finance/settlements/${s.id}',
      IssueSubjectKind.refund => '/finance/refunds?id=${s.id}',
      IssueSubjectKind.paymentRequest => '/more/approvals?id=${s.id}',
      IssueSubjectKind.rider => '/more/riders/${s.id}',
      IssueSubjectKind.unknown => null,
    };

/// Failed or delayed transactions (§7 tracking 5), grouped by kind with a
/// count each. Failed payments follow the period; the rest are the state now.
class IssuesScreen extends ConsumerWidget {
  const IssuesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final args = (q: ref.watch(financeQueryProvider), type: null);
    final value = ref.watch(financeIssuesProvider(args));
    final data = value.value;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Failed or delayed transactions'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: data == null
          ? (value.hasError
              ? ErrorRetry(error: value.error!, onRetry: () => ref.invalidate(financeIssuesProvider(args)))
              : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: () => ref.read(financeIssuesProvider(args).notifier).refresh(),
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.only(bottom: 32),
                children: [
                  if (data.items.isEmpty) const EmptyLine('Nothing has failed or is overdue.'),
                  for (final t in [...FinanceIssueType.known, FinanceIssueType.unknown]) ...[
                    if (data.items.any((i) => i.type == t)) ...[
                      GroupLabel('${t.label} (${data.counts[t] ?? data.items.where((i) => i.type == t).length})'),
                      for (final i in data.items.where((i) => i.type == t)) _IssueRow(issue: i),
                    ],
                  ],
                  if (data.hasMore)
                    TextButton(
                      onPressed: () => ref.read(financeIssuesProvider(args).notifier).loadMore(),
                      child: const Text('Show more'),
                    ),
                ],
              ),
            ),
    );
  }
}

class _IssueRow extends StatelessWidget {
  const _IssueRow({required this.issue});
  final FinanceIssue issue;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final i = issue;
    final route = issueRoute(i.subject);
    final amount = i.amount;
    return FinanceRow(
      onTap: route == null ? null : () => context.push(route),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(i.subject.label, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
              if (amount != null)
                Text(i.subject.kind == IssueSubjectKind.rider || i.subject.kind == IssueSubjectKind.paymentRequest
                        ? rupeesFlex(amount)
                        : rupees(amount),
                    style: dataStyle(context, size: 15, weight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 2),
          StatusText(i.title, color: i.severity == IssueSeverity.critical ? c.deal : c.amberText),
          if (i.detail != null) Text(i.detail!, style: TextStyle(fontSize: 12.5, color: c.muted)),
          if (i.since != null) Text('Since ${placedAt(i.since)}', style: TextStyle(fontSize: 12.5, color: c.muted)),
          if (i.reference != null) ReferenceText(i.reference!, copyKey: Key('copy-issue-${i.subject.id}-${i.type.wire}')),
        ],
      ),
    );
  }
}
