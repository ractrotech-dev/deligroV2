import 'dart:convert';

import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/core/entity_routes.dart';
import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/data/alerts_repository.dart';
import 'package:deligro_manager/data/tickets_repository.dart';
import 'package:deligro_manager/features/cash/cash_screen.dart';
import 'package:deligro_manager/features/support/ticket_thread_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'rider_helpers.dart';

/// Phase 8 integration: how the app takes what the server actually sends.
ApiClient _client(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(GoTrueClient(url: 'http://x'), client: MockClient(handler));

void main() {
  group('resetting an alert rule carries its client action id', () {
    test('a fresh id each time, or the one given (a retry reuses it)', () async {
      final seen = <Uri>[];
      final repo = ApiAlertsRepository(_client((req) async {
        seen.add(req.url);
        expect(req.method, 'DELETE');
        return http.Response(jsonEncode({'rule': null}), 200);
      }));
      await repo.resetRule('order_unassigned', 'z-1');
      await repo.resetRule('order_unassigned', 'z-1', clientActionId: 'retry-1');
      await repo.resetRule('order_unassigned', 'z-1', clientActionId: 'retry-1');
      expect(seen[0].queryParameters['clientActionId'], isNotEmpty);
      expect(seen[0].queryParameters['kind'], 'order_unassigned');
      expect(seen[0].queryParameters['zone'], 'z-1');
      expect(seen[1].queryParameters['clientActionId'], 'retry-1');
      expect(seen[2].queryParameters['clientActionId'], 'retry-1');
    });
  });

  group('ticket refusals', () {
    test('a refused move says where the ticket can go', () {
      const r = Refused<Object?>('invalid_transition', [], null, {'allowed': ['waiting_on_requester', 'resolved']});
      final text = ticketRefusalText(r);
      expect(text, contains("isn't allowed"));
      expect(text, contains('waiting on requester, resolved'));
      expect(ticketRefusalText(const Refused<Object?>('invalid_transition')), isNot(contains('It can go to')));
    });

    test('files that are too big read as a refusal, not a crash', () async {
      final repo = ApiTicketsRepository(_client((_) async => http.Response(jsonEncode({'error': 'too_large'}), 413)));
      final out = await repo.setStatus('t-1', TicketStatusChange(status: TicketStatus.resolved, resolution: 'Done now'));
      expect(out, isA<Refused<void>>());
      expect((out as Refused<void>).code, 'too_large');
      expect(ticketRefusalText(out), contains('too big'));
    });

    test('a 409 invalid_transition keeps the allowed list for the message', () async {
      final repo = ApiTicketsRepository(_client((_) async => http.Response(
            jsonEncode({'error': 'invalid_transition', 'allowed': ['in_progress']}),
            409,
          )));
      final out = await repo.setStatus('t-1', TicketStatusChange(status: TicketStatus.closed));
      expect(ticketRefusalText(out as Refused<void>), contains('in progress'));
    });
  });

  group('a cash alert opens that rider and day', () {
    test('the server keys it riderId:day', () {
      expect(routeForEntity('cash_day', '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f:2026-10-20'), '/more/cash?rider=9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f&day=2026-10-20');
      expect(routeForEntity('cash_day', 'not-a-key'), '/more/cash');
      expect(safeAppPath('/more/cash?rider=9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f&day=2026-10-20'), isNotNull, reason: 'the link is one of the app\'s own');
    });

    testWidgets('only that rider\'s deposits show, with a way back to everyone', (tester) async {
      await pumpRider(
        tester,
        const CashScreen(riderId: 'r-2'),
        fakes: RiderFakes(),
        permissions: {...riderViewer, 'manager.cash'},
        size: const Size(420, 1000),
      );
      expect(find.byKey(const Key('cash-rider-filter')), findsOneWidget);
      expect(find.text('Sunil Verma'), findsWidgets);
      expect(find.text('Ravi Kumar · DR-0007'), findsNothing);

      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('cash-rider-filter')), findsNothing);
      expect(find.text('Ravi Kumar · DR-0007'), findsOneWidget);
    });
  });

  group('an alert push or inbox row opens its alert', () {
    test('by alertId, whatever else it carries', () {
      expect(
        inAppPathFrom(null, {'kind': 'order_unassigned', 'orderId': 'o-12345678', 'url': '/alerts/a-1234567', 'alertId': 'a-1234567'}),
        '/alerts/a-1234567',
      );
      expect(inAppPathFrom(null, {'alertId': 'x'}), isNot('/alerts/x'), reason: 'too short to be an id');
    });
  });
}
