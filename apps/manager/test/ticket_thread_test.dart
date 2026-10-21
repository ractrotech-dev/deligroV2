import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/support/ticket_thread_screen.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'fixtures/fixtures.dart';
import 'vp_helpers.dart';

TicketThread _thread({String status = 'in_progress'}) {
  final j = apiFixture('ticket_thread');
  return TicketThread.fromJson({
    ...j,
    'ticket': {...(j['ticket'] as Map<String, dynamic>), 'status': status},
  });
}

Future<FakeTicketsRepository> _screen(WidgetTester tester, {FakeTicketsRepository? repo}) async {
  final fake = repo ?? FakeTicketsRepository();
  await pumpVp(tester, const TicketThreadScreen(ticketId: 't-1'), tickets: fake, size: const Size(400, 900));
  await tester.pumpAndSettle();
  return fake;
}

void main() {
  testWidgets('messages read oldest first; internal notes are labelled', (tester) async {
    await _screen(tester);
    expect(find.text('Cold food delivered'), findsOneWidget);
    expect(find.text('Internal note'), findsOneWidget);
    final first = tester.getTopLeft(find.text('The food arrived cold.')).dy;
    final second = tester.getTopLeft(find.text('Called the kitchen; they will remake it.')).dy;
    expect(first < second, isTrue);
  });

  testWidgets('with Internal note on, the reply goes as internal', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('ticket-internal-toggle')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('ticket-composer')), 'Kitchen confirmed the remake.');
    await tester.pump();
    await tester.tap(find.byKey(const Key('ticket-send')));
    await tester.pumpAndSettle();
    expect(fake.replyCalls.single.internal, isTrue);
    expect(fake.replyCalls.single.body, 'Kitchen confirmed the remake.');
  });

  testWidgets('resolving asks for a resolution of at least 3 characters', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('ticket-status-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Resolved').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('reason-field')), 'ok');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Replacement delivered, customer happy');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    final s = fake.statusCalls.single;
    expect(s.status, TicketStatus.resolved);
    expect(s.resolution, 'Replacement delivered, customer happy');
  });

  testWidgets('a closed ticket has no composer and no status menu', (tester) async {
    await _screen(tester, repo: FakeTicketsRepository(thread: _thread(status: 'closed')));
    expect(find.byKey(const Key('ticket-composer')), findsNothing);
    expect(find.byKey(const Key('ticket-status-menu')), findsNothing);
    expect(find.textContaining('closed'), findsWidgets);
  });

  testWidgets('a reply that hit a network error is retried with the same id', (tester) async {
    final fake = FakeTicketsRepository()..replyError = ApiException(0, 'network');
    await _screen(tester, repo: fake);
    await tester.enterText(find.byKey(const Key('ticket-composer')), 'On it.');
    await tester.pump();
    await tester.tap(find.byKey(const Key('ticket-send')));
    await tester.pumpAndSettle();
    expect(find.text('Retry'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(fake.replyCalls, hasLength(2));
    expect(fake.replyCalls[1].clientActionId, fake.replyCalls[0].clientActionId);
    expect(find.byKey(const Key('ticket-composer')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('ticket-composer'))).controller!.text, isEmpty);
  });

  test('ticket links in pushes open the ticket', () {
    const id = '7b0f2c1e-1111-4222-8333-444455556666';
    expect(inAppPathFrom('/more/tickets/$id', null), '/more/tickets/$id');
    expect(inAppPathFrom('https://deligrodelivery.ractrotech.com/admin/support/$id', null), '/more/tickets/$id');
    expect(inAppPathFrom(null, {'appPath': '/admin/tickets/$id'}), '/more/tickets/$id');
  });
}
