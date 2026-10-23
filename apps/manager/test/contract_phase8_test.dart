import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/alerts.dart';
import 'package:deligro_manager/models/audit.dart';
import 'package:deligro_manager/models/inbox.dart';
import 'package:deligro_manager/models/support_ops.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:deligro_manager/core/entity_routes.dart';
import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/alerts/alert_labels.dart';
import 'package:deligro_manager/state/paged.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 8 contract check, app half. `scripts/qa/manager-contract-phase8.ts`
/// runs the support, alert, inbox and audit readers against a seeded fake
/// PostgREST and writes what each route sends to
/// `fixtures/api/generated/phase8/`. This checks every key a hand fixture in
/// `fixtures/api/phase8/` has is also in the server's answer, with the same
/// JSON type, and then parses the server's answer with the models.
///
///   npm run test:manager-contract   (from the repo root)
///   flutter test test/contract_phase8_test.dart
Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _gen(String name) => _json('test/fixtures/api/generated/phase8/$name.json');
Map<String, dynamic> _hand(String name) => _json('test/fixtures/api/phase8/$name.json');

String _kind(Object? v) => switch (v) {
      null => 'null',
      bool() => 'bool',
      num() => 'num',
      String() => 'str',
      List() => 'list',
      Map() => 'object',
      _ => v.runtimeType.toString(),
    };

/// Every key in [hand] is in [gen] with the same JSON type. A null on either
/// side matches anything; list elements are each checked against the hand
/// fixture's first element. [optional] lists dotted paths the server may omit.
/// Free-form payloads (an inbox row's `data`, an audit entry's before/after)
/// differ by row, so below them only the JSON kind is compared.
const _opaque = ['.data', '.before', '.after'];

void _sameShape(Object? hand, Object? gen, String path, List<String> errors, Set<String> optional) {
  if (hand == null || gen == null) return;
  if (_kind(hand) != _kind(gen)) {
    errors.add('$path: server sends ${_kind(gen)}, app fixture has ${_kind(hand)}');
    return;
  }
  if (_opaque.any(path.endsWith)) return;
  if (hand is Map && gen is Map) {
    for (final k in hand.keys) {
      final p = '$path.$k';
      if (!gen.containsKey(k)) {
        if (!optional.contains(p)) errors.add('$p: missing from the server answer');
        continue;
      }
      _sameShape(hand[k], gen[k], p, errors, optional);
    }
  } else if (hand is List && gen is List && hand.isNotEmpty) {
    for (var i = 0; i < gen.length; i++) {
      _sameShape(hand.first, gen[i], '$path[]', errors, optional);
    }
  }
}

void _expectSameShape(String name, {Set<String> optional = const {}}) {
  final errors = <String>[];
  _sameShape(_hand(name), _gen(name), name, errors, optional);
  expect(errors, isEmpty, reason: errors.join('\n'));
}

void main() {
  group('server answers carry every field the app fixtures have', () {
    for (final name in [
      'tickets_list',
      'ticket_thread_v2',
      'ticket_metrics',
      'assignees',
      'alerts_list',
      'alert_detail',
      'alert_rules',
      'inbox',
      'unread_count',
      'audit_list',
      'audit_entry',
      'audit_actions',
    ]) {
      test(name, () => _expectSameShape(name));
    }
  });

  group('the models read the server answers without falling back', () {
    test('the support queue: urgent first, counts on page one only', () {
      final p1 = TicketListPage.fromJson(_gen('tickets_list'));
      expect(p1.items, isNotEmpty);
      expect(p1.items.first.summary.priority.name, 'emergency', reason: 'the emergency leads');
      expect(p1.counts.escalated, greaterThan(0));
      expect(p1.items.map((t) => t.summary.status), isNot(contains(TicketStatus.unknown)));

      // Page two sends `counts: null`: it parses, and appending it must not
      // blank the chips the first page filled in.
      final raw2 = _gen('tickets_list_page2');
      expect(raw2['counts'], isNull);
      final p2 = TicketListPage.fromJson(raw2);
      final list = Paged<TicketListItem, TicketCounts>.first(p1.items, 'next', p1.counts);
      final merged = list.append(p2.items, p2.nextCursor, (t) => t.summary.id);
      expect(merged.counts.escalated, p1.counts.escalated);
      // The fake has no paging, so page two repeats rows; appending shows each once.
      expect({for (final t in merged.items) t.summary.id}.length, merged.items.length);
      expect(merged.items.length, greaterThanOrEqualTo(p1.items.length));
    });

    test('a staff ticket thread: who, where it can go, its history, an internal note, a signed link', () {
      final t = TicketThread.fromJson(_gen('ticket_thread_v2'));
      expect(t.ticket.requester?.name, isNotEmpty);
      expect(t.ticket.assignee?.name, isNotEmpty);
      expect(t.ticket.allowedTransitions, isNotEmpty);
      expect(t.events, isNotEmpty);
      expect(t.messages.any((m) => m.internal), isTrue);
      expect(t.messages.expand((m) => m.attachments).every((a) => a.url.isNotEmpty), isTrue);
      expect(t.ticket.summary.status, isNot(TicketStatus.unknown));
    });

    test('a resolved ticket thread offers reopen and close, not a new status', () {
      final t = TicketThread.fromJson(_gen('ticket_thread_resolved'));
      expect(t.ticket.summary.status, TicketStatus.resolved);
      expect(t.ticket.allowedTransitions!.toSet(), {TicketStatus.closed, TicketStatus.inProgress});
      expect(t.ticket.resolution, isNotEmpty);
    });

    test('support metrics and the people a ticket can be assigned to', () {
      final m = TicketMetrics.fromJson(_gen('ticket_metrics'));
      expect(m.created, greaterThan(0));
      expect(m.recurringCategories, isNotEmpty);
      expect(m.recurringVendors.first.label, isNotEmpty);
      expect(AssigneeList.fromJson(_gen('assignees')).staff, isNotEmpty);
    });

    test('alerts: every kind and status is known, the cash alert keeps its day', () {
      final page = AlertPage.fromJson(_gen('alerts_list'));
      expect(page.items.map((a) => a.kind), isNot(contains(AlertKind.unknown)));
      expect(page.items.map((a) => a.status), isNot(contains(AlertStatus.unknown)));
      expect(page.counts.open, greaterThan(0));
      final cash = page.items.firstWhere((a) => a.entityType == 'cash_day');
      expect(cash.entityId, contains(':'));
      final d = AlertDetail.fromJson(_gen('alert_detail'));
      expect(d.history, isNotEmpty);
    });

    test('an alert opens the screen for the thing it is about', () {
      final page = AlertPage.fromJson(_gen('alerts_list'));
      for (final a in page.items) {
        final route = alertTarget(a);
        expect(route, startsWith('/'), reason: '${a.kind} → $route');
      }
      final cash = page.items.firstWhere((a) => a.entityType == 'cash_day');
      final rider = cash.entityId.split(':').first;
      final day = cash.entityId.split(':').last;
      expect(routeForEntity(cash.entityType, cash.entityId, alertId: cash.id), '/more/cash?rider=$rider&day=$day');
    });

    test('alert rules inherit by zone', () {
      final rules = [for (final r in (_gen('alert_rules')['rules'] as List)) AlertRule.fromJson(r as Map<String, dynamic>)];
      expect(rules, isNotEmpty);
      final own = rules.firstWhere((r) => r.kindWire == 'order_unassigned');
      expect(own.inherited, isFalse);
      expect(own.threshold, 8);
    });

    test('the inbox and the bell; a push for an alert opens that alert', () {
      final page = InboxPage.fromJson(_gen('inbox'));
      expect(page.items, hasLength(2));
      expect(page.unread, 1);
      final u = UnreadCount.fromJson(_gen('unread_count'));
      expect(u.unread, 1);
      expect(u.openAlerts, greaterThan(0));
      final alertRow = page.items.firstWhere((i) => (i.data['alertId'] as String?) != null);
      expect(inAppPathFrom(null, alertRow.data), '/alerts/${alertRow.data['alertId']}');
      final ticketRow = page.items.firstWhere((i) => (i.data['ticketId'] as String?) != null);
      expect(inAppPathFrom(null, ticketRow.data), startsWith('/more/tickets/'));
    });

    test('the audit log: a numeric id, redacted values, a diff, the action catalogue', () {
      final page = AuditPage.fromJson(_gen('audit_list'));
      expect(page.items, isNotEmpty);
      expect(page.items.first.id, isA<int>());
      final d = AuditEntryDetail.fromJson(_gen('audit_entry'));
      expect(d.entry.id, 4021);
      expect(jsonEncode(_gen('audit_entry')), isNot(contains('9876543210')), reason: 'the phone number is redacted');
      expect(d.diff, isNotEmpty);
      expect(_gen('audit_actions')['actions'], isNotEmpty);
    });
  });
}
