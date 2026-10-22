import 'package:deligro_manager/models/alerts.dart';
import 'package:deligro_manager/models/audit.dart';
import 'package:deligro_manager/models/inbox.dart';
import 'package:deligro_manager/models/support_ops.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures/fixtures.dart';

Map<String, dynamic> p8(String name) => apiFixture('phase8/$name');

void main() {
  group('tickets (Phase 8)', () {
    test('the queue page parses items, cursor and counts', () {
      final page = TicketListPage.fromJson(p8('tickets_list'));
      expect(page.items, hasLength(3));
      expect(page.nextCursor, 'c-2');
      expect(page.counts.unassigned, 3);
      expect(page.counts.mine, 2);
      expect(page.counts.active, 4 + 2 + 1 + 1);
      final first = page.items.first;
      expect(first.summary.status, TicketStatus.escalated);
      expect(first.assignee?.name, 'Ravi Kumar');
      expect(first.team, TicketTeam.customerSupport);
      expect(first.escalationLevel, 2);
      expect(first.requester?.role, RequesterRole.customer);
      expect(page.items[1].assignee, isNull);
      expect(page.items[1].awaitingFirstResponse, isTrue);
      expect(page.items[1].ageMinutes, 42);
      expect(page.items[2].restaurant?.name, 'Biryani House');
    });

    test('the v2 thread carries assignee, team, requester, transitions and events', () {
      final t = TicketThread.fromJson(p8('ticket_thread_v2'));
      expect(t.ticket.assignee?.id, 'm-1');
      expect(t.ticket.team, TicketTeam.customerSupport);
      expect(t.ticket.requester?.name, 'Asha');
      expect(t.ticket.allowedTransitions,
          [TicketStatus.waitingOnRequester, TicketStatus.escalated, TicketStatus.resolved]);
      expect(t.events, hasLength(5));
      expect(t.events.first.kind, TicketEventKind.created);
      expect(t.events[3].reason, 'Customer threatened chargeback');
      // A kind this build doesn't know reads as unknown, never a throw.
      expect(t.events.last.kind, TicketEventKind.unknown);
      expect(t.events.last.actor, isNull);
    });

    test('display labels cover every database status', () {
      expect(TicketStatus.open.displayLabel, 'Open');
      expect(TicketStatus.inProgress.displayLabel, 'In Progress');
      expect(TicketStatus.waitingOnRequester.displayLabel, 'In Progress · waiting on requester');
      expect(TicketStatus.escalated.displayLabel, 'Escalated');
      expect(TicketStatus.resolved.displayLabel, 'Resolved');
      expect(TicketStatus.closed.displayLabel, 'Closed');
    });

    test('metrics parse figures and the five recurring lists', () {
      final m = TicketMetrics.fromJson(p8('ticket_metrics'));
      expect(m.firstResponse.avgMinutes, 22);
      expect(m.firstResponse.medianMinutes, 15);
      expect(m.resolution.avgMinutes, 410);
      expect(m.openOverSla, 3);
      expect(m.recurringCategories.first.label, 'Order issue');
      expect(m.recurringCategories.first.share, 0.3);
      expect(m.recurringRiders.single.code, 'DR-0004');
      expect(m.recurringOrders.single.label, 'AB12CD34');
      expect(m.daily, hasLength(3));
      expect(m.generatedAt, isNotNull);
    });

    test('assignees and teams parse', () {
      final a = AssigneeList.fromJson(p8('assignees'));
      expect(a.staff.first.openAssigned, 3);
      expect(a.teams, contains(TicketTeam.finance));
    });

    test('filters build the pinned query', () {
      final f = TicketFilters(
        statuses: const {'active'},
        priorities: const {'high', 'emergency'},
        requesterRoles: const {'customer'},
        assignee: 'unassigned',
        team: TicketTeam.finance,
        zoneId: 'z-1',
        q: 'cold',
        from: DateTime(2026, 10, 1),
        to: DateTime(2026, 10, 21),
      );
      expect(f.toQuery(), {
        'status': 'active',
        'priority': 'emergency,high',
        'requesterRole': 'customer',
        'assignee': 'unassigned',
        'team': 'finance',
        'zone': 'z-1',
        'q': 'cold',
        'from': '2026-10-01',
        'to': '2026-10-21',
      });
      expect(f, TicketFilters.fromQuery(f.toQuery()));
    });
  });

  group('alerts', () {
    test('the list parses, unknown kinds read as unknown, critical first', () {
      final page = AlertPage.fromJson(p8('alerts_list'));
      expect(page.counts.open, 5);
      expect(page.counts.critical, 1);
      expect(page.items.map((a) => a.kind),
          [AlertKind.orderUnassigned, AlertKind.deliveryFailed, AlertKind.unknown]);
      expect(sortAlerts(page.items).first.id, 'al-1');
      expect(page.items[1].reopenCount, 1);
      expect(page.items[2].acknowledgedBy?.name, 'Ravi Kumar');
    });

    test('detail and history parse', () {
      final d = AlertDetail.fromJson(p8('alert_detail'));
      expect(d.alert.status, AlertStatus.resolved);
      expect(d.alert.resolvedBy?.name, 'Ravi Kumar');
      expect(d.history.map((h) => h.event), ['opened', 'acknowledged', 'resolved']);
    });

    test('rules parse inherited, units and thresholds as numbers', () {
      final rules = AlertRule.listFromJson(p8('alert_rules'));
      expect(rules.first.inherited, isTrue);
      expect(rules[1].inherited, isFalse);
      expect(rules[1].unit, ThresholdUnit.percent);
      expect(rules[1].windowMinutes, 60);
      expect(rules[2].threshold, 500);
      expect(rules[2].unit, ThresholdUnit.rupees);
      expect(rules[3].unit, ThresholdUnit.none);
    });
  });

  group('inbox and audit', () {
    test('inbox items and the unread count parse', () {
      final page = InboxPage.fromJson(p8('inbox'));
      expect(page.unread, 7);
      expect(page.items.first.isUnread, isTrue);
      expect(page.items.first.url, '/orders/o-1');
      expect(page.items.first.alertId, 'al-2');
      expect(page.items[1].isUnread, isFalse);
      final u = UnreadCount.fromJson(p8('unread_count'));
      expect(u.unread, 7);
      expect(u.criticalAlerts, 1);
    });

    test('audit entries, diffs and the action catalog parse', () {
      final page = AuditPage.fromJson(p8('audit_list'));
      expect(page.items.first.action, 'delivery.reassign');
      expect(page.items.first.before?['riderId'], 'r-1');
      expect(page.items[1].before, isNull);
      expect(page.nextCursor, '1201');
      final e = AuditEntryDetail.fromJson(p8('audit_entry'));
      expect(e.diff, hasLength(2));
      expect(e.diff.last.after, 'false');
      expect(e.diff.last.before, '—');
      final actions = AuditActionDef.listFromJson(p8('audit_actions'));
      expect(actions.where((a) => a.group == 'Orders'), hasLength(2));
    });
  });
}
