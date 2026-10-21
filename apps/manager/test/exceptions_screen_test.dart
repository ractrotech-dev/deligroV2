import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/live/exceptions_screen.dart';
import 'package:deligro_manager/models/delivery_exception.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_rider_repositories.dart';
import 'rider_helpers.dart';

const _decider = {...riderViewer, 'manager.exceptions.decide'};

Future<RiderFakes> _pump(WidgetTester tester, {RiderFakes? fakes, Set<String> permissions = _decider}) async {
  final f = fakes ?? RiderFakes();
  await pumpRider(tester, const ExceptionsScreen(), fakes: f, permissions: permissions, size: const Size(420, 1400));
  return f;
}

void main() {
  testWidgets('a report shows only Acknowledge; a request shows Approve and Reject', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('ex-ack-ex-2')), findsOneWidget);
    expect(find.byKey(const Key('ex-approve-ex-2')), findsNothing);
    expect(find.byKey(const Key('ex-approve-ex-1')), findsOneWidget);
    expect(find.byKey(const Key('ex-reject-ex-1')), findsOneWidget);
    expect(find.text('Delivery failed'), findsOneWidget);
    expect(find.text('Kitchen delay'), findsOneWidget);
  });

  testWidgets('no buttons when the server offers no decisions', (tester) async {
    final page = ExceptionPage.fromJson({
      ...p5('exceptions'),
      'items': [
        for (final e in (p5('exceptions')['items'] as List)) {...(e as Map).cast<String, dynamic>(), 'decisions': <String>[]},
      ],
    });
    await _pump(tester, fakes: RiderFakes(exceptions: FakeExceptionsRepository(page: page)), permissions: riderViewer);
    expect(find.byKey(const Key('ex-approve-ex-1')), findsNothing);
    expect(find.byKey(const Key('ex-ack-ex-2')), findsNothing);
    expect(find.text('Deciding needs the "Delivery exceptions" permission.'), findsOneWidget);
  });

  testWidgets('approving a failed delivery warns about the cancellation first', (tester) async {
    final fakes = await _pump(tester);
    await tester.tap(find.byKey(const Key('ex-approve-ex-1')));
    await tester.pumpAndSettle();
    expect(find.text('This cancels order AB12CD34 and refunds the customer per the usual rules.'), findsOneWidget);
    expect(fakes.exceptions.decideCalls, isEmpty);
    await tester.tap(find.text('Approve and cancel'));
    await tester.pumpAndSettle();
    expect(fakes.exceptions.decideCalls.single.action.decision, ExceptionDecision.approve);
  });

  testWidgets('Reject needs a note', (tester) async {
    final fakes = await _pump(tester);
    await tester.tap(find.byKey(const Key('ex-reject-ex-1')));
    await tester.pumpAndSettle();
    final submit = find.byKey(const Key('reason-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Customer picked up the call');
    await tester.pump();
    await tester.tap(submit);
    await tester.pumpAndSettle();
    final a = fakes.exceptions.decideCalls.single.action;
    expect(a.decision, ExceptionDecision.reject);
    expect(a.note, 'Customer picked up the call');
  });

  testWidgets('effect_failed: the decision stands, Retry re-sends the identical action', (tester) async {
    final fakes = RiderFakes();
    fakes.exceptions.decideResults.add(ApiException(502, 'effect_failed', body: {'error': 'effect_failed', 'exceptionId': 'ex-2'}));
    await _pump(tester, fakes: fakes);
    await tester.tap(find.byKey(const Key('ex-ack-ex-2')));
    await tester.pumpAndSettle();
    expect(find.text('Decision saved; finishing it failed.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('ex-retry-ex-2')));
    await tester.pumpAndSettle();
    final calls = fakes.exceptions.decideCalls;
    expect(calls, hasLength(2));
    expect(calls[1].action.clientActionId, calls[0].action.clientActionId);
    expect(find.text('Decision saved; finishing it failed.'), findsNothing);
  });

  testWidgets('already_resolved is explained', (tester) async {
    final fakes = RiderFakes();
    fakes.exceptions.decideResults.add(const Refused<DeliveryException>('already_resolved'));
    await _pump(tester, fakes: fakes);
    await tester.tap(find.byKey(const Key('ex-ack-ex-2')));
    await tester.pumpAndSettle();
    expect(find.text('Someone else already decided this.'), findsOneWidget);
  });

  testWidgets('the Live badge shows how many need a decision', (tester) async {
    await pumpRider(tester, const Scaffold(body: ExceptionsBadge()), permissions: _decider);
    expect(find.text('Needs a decision (2)'), findsOneWidget);
  });

  testWidgets('the badge stays hidden when nothing is pending', (tester) async {
    final fakes = RiderFakes(exceptions: FakeExceptionsRepository(page: const ExceptionPage(items: [])));
    await pumpRider(tester, const Scaffold(body: ExceptionsBadge()), fakes: fakes, permissions: _decider);
    expect(find.textContaining('Needs a decision'), findsNothing);
  });
}
