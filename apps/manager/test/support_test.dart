import 'dart:typed_data';

import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/support/support_metrics_screen.dart';
import 'package:deligro_manager/features/support/support_queue_screen.dart';
import 'package:deligro_manager/features/support/ticket_thread_screen.dart';
import 'package:deligro_manager/models/support_ops.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:deligro_manager/widgets/document_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'fixtures/fixtures.dart';
import 'vp_helpers.dart';

const _support = {'manager.support.manage', 'manager.vendors.view', 'manager.orders.view'};

TicketThread _v2({int level = 1, String status = 'in_progress', List<String>? allowed}) {
  final j = apiFixture('phase8/ticket_thread_v2');
  return TicketThread.fromJson({
    ...j,
    'ticket': {
      ...(j['ticket'] as Map<String, dynamic>),
      'escalationLevel': level,
      'status': status,
      'allowedTransitions': ?allowed,
    },
  });
}

Future<FakeTicketsRepository> _thread(WidgetTester tester, {FakeTicketsRepository? repo, List extra = const []}) async {
  final fake = repo ?? FakeTicketsRepository(thread: _v2());
  await pumpVp(tester, const TicketThreadScreen(ticketId: 't-1'),
      tickets: fake, permissions: _support, size: const Size(400, 900), extra: extra);
  await tester.pumpAndSettle();
  return fake;
}

Future<void> _openActions(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('ticket-status-menu')));
  await tester.pumpAndSettle();
}

void main() {
  group('queue', () {
    testWidgets('chips carry the counts; rows show status, priority, assignee and age', (tester) async {
      final fake = FakeTicketsRepository();
      await pumpVp(tester, const SupportQueueScreen(), tickets: fake, permissions: _support);
      await tester.pumpAndSettle();
      expect(find.text('Active (8)'), findsOneWidget);
      expect(find.text('Escalated (1)'), findsOneWidget);
      expect(find.text('Unassigned (3)'), findsOneWidget);
      expect(find.text('Mine (2)'), findsOneWidget);
      expect(find.text('In Progress · waiting on requester'), findsOneWidget);
      expect(find.text('Unassigned'), findsWidgets);
      expect(find.textContaining('Ravi Kumar'), findsOneWidget);
      expect(find.text('Level 2'), findsOneWidget);
      expect(find.text('Emergency'), findsOneWidget);
      expect(find.text('42 min'), findsOneWidget);
      // The default view is the active queue.
      expect(fake.listCalls.first.$1.statuses, {'active'});
    });

    testWidgets('the Unassigned chip asks for unassigned active tickets', (tester) async {
      final fake = FakeTicketsRepository();
      await pumpVp(tester, const SupportQueueScreen(), tickets: fake, permissions: _support);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('ticket-queue-unassigned')));
      await tester.tap(find.byKey(const Key('ticket-queue-unassigned')));
      await tester.pumpAndSettle();
      final f = fake.listCalls.last.$1;
      expect(f.assignee, 'unassigned');
      expect(f.statuses, {'active'});
    });

    testWidgets('the filters sheet builds priority, requester and team filters', (tester) async {
      final fake = FakeTicketsRepository();
      await pumpVp(tester, const SupportQueueScreen(), tickets: fake, permissions: _support, size: const Size(400, 1000));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tickets-filters')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tf-priority-high')));
      await tester.tap(find.byKey(const Key('tf-role-restaurant')));
      await tester.ensureVisible(find.byKey(const Key('tf-team-finance')));
      await tester.tap(find.byKey(const Key('tf-team-finance')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('tf-apply')));
      await tester.tap(find.byKey(const Key('tf-apply')));
      await tester.pumpAndSettle();
      final f = fake.listCalls.last.$1;
      expect(f.priorities, {'high'});
      expect(f.requesterRoles, {'restaurant'});
      expect(f.team, TicketTeam.finance);
      expect(f.statuses, {'active'});
    });
  });

  group('thread', () {
    testWidgets('the header shows assignee, team and level; internal notes say who can see them', (tester) async {
      await _thread(tester);
      expect(find.textContaining('Assigned to Ravi Kumar'), findsOneWidget);
      expect(find.textContaining('Customer support'), findsOneWidget);
      expect(find.text('Escalated · level 1'), findsOneWidget);
      expect(find.text('Internal — not visible to requester'), findsOneWidget);
    });

    testWidgets('the menu offers only allowed statuses', (tester) async {
      await _thread(tester);
      await _openActions(tester);
      expect(find.text('Resolve'), findsOneWidget);
      expect(find.text('Waiting on requester'), findsOneWidget);
      expect(find.text('Close'), findsNothing);
      expect(find.text('Assign…'), findsOneWidget);
      expect(find.text('Change priority…'), findsOneWidget);
      expect(find.text('Escalate…'), findsOneWidget);
    });

    testWidgets('Resolve needs at least 3 characters of resolution', (tester) async {
      final fake = await _thread(tester);
      await _openActions(tester);
      await tester.tap(find.text('Resolve'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('reason-field')), 'ok');
      await tester.pump();
      expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Refund issued');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      expect(fake.statusCalls.single.status, TicketStatus.resolved);
      expect(fake.statusCalls.single.resolution, 'Refund issued');
    });

    testWidgets('Escalate is not offered at level 3', (tester) async {
      await _thread(tester, repo: FakeTicketsRepository(thread: _v2(level: 3)));
      await _openActions(tester);
      expect(find.text('Escalate…'), findsNothing);
      expect(find.text('Escalated to the top level'), findsOneWidget);
    });

    testWidgets('escalating sends the reason', (tester) async {
      final fake = await _thread(tester);
      await _openActions(tester);
      await tester.tap(find.text('Escalate…'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('reason-field')), 'No reply from the kitchen in 2 hours');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      expect(fake.escalateCalls.single.reason, 'No reply from the kitchen in 2 hours');
    });

    testWidgets('reopening a resolved ticket asks for a reason', (tester) async {
      final fake = await _thread(tester,
          repo: FakeTicketsRepository(thread: _v2(status: 'resolved', allowed: ['in_progress', 'closed'])));
      await _openActions(tester);
      await tester.tap(find.text('Reopen…'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('reason-field')), 'Customer says it happened again');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      final s = fake.statusCalls.single;
      expect(s.status, TicketStatus.inProgress);
      expect(s.reason, 'Customer says it happened again');
    });

    testWidgets('assigning picks a person and a team; a network error retries with the same id', (tester) async {
      final fake = FakeTicketsRepository(thread: _v2())..assignError = ApiException(0, 'network');
      await _thread(tester, repo: fake);
      await _openActions(tester);
      await tester.tap(find.text('Assign…'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('assignee-a-1')));
      await tester.tap(find.byKey(const Key('assign-team-finance')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('assign-save')));
      await tester.pumpAndSettle();
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(fake.assignCalls, hasLength(2));
      expect(fake.assignCalls[1].clientActionId, fake.assignCalls[0].clientActionId);
      expect(fake.assignCalls.last.assigneeId, 'a-1');
      expect(fake.assignCalls.last.team, TicketTeam.finance);
    });

    testWidgets('the composer takes up to 4 attachments and sends them with the reply', (tester) async {
      var n = 0;
      final fake = await _thread(tester, extra: [
        documentPickerProvider.overrideWithValue((_) async => XFile.fromData(
              Uint8List.fromList(List.filled(10, 1)),
              name: 'photo${++n}.jpg',
              path: 'photo$n.jpg',
            )),
      ]);
      for (var i = 0; i < 4; i++) {
        await tester.tap(find.byKey(const Key('ticket-attach')));
        await tester.pumpAndSettle();
      }
      expect(find.text('photo4.jpg'), findsOneWidget);
      await tester.tap(find.byKey(const Key('ticket-attach')));
      await tester.pumpAndSettle();
      expect(find.text('Up to 4 attachments'), findsOneWidget);
      // Let the notice go before reaching for Send.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('ticket-composer')), 'Photos of the receipt.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('ticket-send')));
      await tester.pumpAndSettle();
      expect(fake.replyCalls.single.files, hasLength(4));
    });

    testWidgets('the History tab lists the events', (tester) async {
      await _thread(tester);
      await tester.tap(find.text('History'));
      await tester.pumpAndSettle();
      expect(find.text('Ticket raised'), findsOneWidget);
      expect(find.textContaining('Assigned to Ravi Kumar by Neha'), findsOneWidget);
      expect(find.textContaining('Customer threatened chargeback'), findsOneWidget);
      expect(find.text('First response'), findsOneWidget);
    });
  });

  group('metrics', () {
    testWidgets('figures, the chart and the recurring lists render', (tester) async {
      final fake = FakeTicketsRepository();
      await pumpVp(tester, const SupportMetricsScreen(), tickets: fake, permissions: _support, size: const Size(400, 2400));
      await tester.pumpAndSettle();
      expect(find.text('22 min'), findsOneWidget);
      expect(find.text('15 min'), findsOneWidget);
      expect(find.text('6 h 50 min'), findsOneWidget);
      expect(find.text('Order issue'), findsOneWidget);
      expect(find.text('Spice Hub'), findsOneWidget);
      expect(find.textContaining('DR-0004'), findsOneWidget);
      expect(find.text('AB12CD34'), findsOneWidget);
      // 30 days is the default range.
      final (from, to, _) = fake.metricsCalls.single;
      expect(to.difference(from).inDays, 29);
    });

    testWidgets('the 7-day chip asks again for 7 days', (tester) async {
      final fake = FakeTicketsRepository();
      await pumpVp(tester, const SupportMetricsScreen(), tickets: fake, permissions: _support, size: const Size(400, 2400));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('metrics-range-7')));
      await tester.pumpAndSettle();
      final (from, to, _) = fake.metricsCalls.last;
      expect(to.difference(from).inDays, 6);
    });
  });

  test('minutes read as minutes, hours and days', () {
    expect(minutesLabel(22), '22 min');
    expect(minutesLabel(410), '6 h 50 min');
    expect(minutesLabel(180), '3 h');
    expect(minutesLabel(60 * 24 * 2 + 60 * 3), '2 d 3 h');
    expect(minutesLabel(null), '—');
  });
}
