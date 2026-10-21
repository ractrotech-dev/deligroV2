import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/orders/order_detail_screen.dart';
import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_orders_repository.dart';
import 'fixtures/fixtures.dart';
import 'helpers.dart';

class _FixedMe extends ManagerMeNotifier {
  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson(meJson);
}

const _id = 'cd34ef56-0000-4000-8000-000000000002';

OrderDetail _detail({Map<String, dynamic> Function(Map<String, dynamic>)? edit}) {
  final j = Map<String, dynamic>.from(apiFixture('order_detail')['order'] as Map);
  return OrderDetail.fromJson(edit == null ? j : edit(j));
}

Future<FakeOrdersRepository> _screen(WidgetTester tester, {FakeOrdersRepository? repo}) async {
  tester.view.physicalSize = const Size(390, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final fake = repo ?? FakeOrdersRepository();
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(await themed(const OrderDetailScreen(orderId: _id), overrides: [
    ordersRepoProvider.overrideWithValue(fake),
    managerMeProvider.overrideWith(_FixedMe.new),
    activeZoneProvider.overrideWithValue(null),
    signedInProvider.overrideWithValue(true),
    mapTilesEnabledProvider.overrideWithValue(false),
  ]));
  await tester.pump();
  await tester.pump();
  return fake;
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('shows items, money, both addresses and the timeline in time order', (tester) async {
    await _screen(tester);
    expect(find.text('CD34EF56'), findsWidgets);
    expect(find.text('Paneer Tikka'), findsOneWidget);
    expect(find.text('2 × ₹180'), findsOneWidget);
    expect(find.byKey(const Key('money-total')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('money-total')), matching: find.text('₹420')), findsOneWidget);
    expect(find.text('Station Road, Bemetara'), findsOneWidget);
    expect(find.text('12 Gandhi Nagar, Bemetara'), findsOneWidget);
    expect(find.text('Near the water tank'), findsOneWidget);
    expect(find.text('Customer says gate is locked; rider to call'), findsOneWidget);
    double y(Finder f) => tester.getTopLeft(f).dy;
    expect(y(find.text('Rider accepted')) < y(find.text('Picked up · via code')), isTrue);
    expect(y(find.text('Picked up · via code')) < y(find.text('Note')), isTrue);
    expect(find.text('updated 9 min ago'), findsOneWidget);
  });

  testWidgets('no Call button without the customer phone; one with it', (tester) async {
    await _screen(tester);
    expect(find.byKey(const Key('call-customer')), findsNothing);
    await _screen(tester,
        repo: FakeOrdersRepository(
          detail: _detail(edit: (j) => {...j, 'customer': {'name': 'Asha', 'phone': '+919800000002'}}),
        ));
    expect(find.byKey(const Key('call-customer')), findsOneWidget);
  });

  testWidgets('only the allowed actions are drawn', (tester) async {
    await _screen(tester);
    expect(find.byKey(const Key('action-advance')), findsOneWidget);
    expect(find.text('Mark Delivered'), findsOneWidget);
    expect(find.byKey(const Key('action-reassign')), findsOneWidget);
    expect(find.byKey(const Key('action-cancel')), findsOneWidget);
    expect(find.byKey(const Key('action-escalate')), findsOneWidget);
    expect(find.byKey(const Key('action-note')), findsOneWidget);
    expect(find.byKey(const Key('action-assign')), findsNothing);
    expect(find.byKey(const Key('action-correct')), findsNothing);

    await _screen(tester,
        repo: FakeOrdersRepository(
          detail: _detail(edit: (j) => {
                ...j,
                'allowed': {...(j['allowed'] as Map), 'reassign': false},
              }),
        ));
    expect(find.byKey(const Key('action-reassign')), findsNothing);
  });

  testWidgets('Cancel needs a reason of at least 3 characters, then sends it', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('action-cancel')));
    await _settle(tester);
    final submit = find.byKey(const Key('reason-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('reason-field')), 'ab');
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Shop closed early');
    await tester.pump();
    await tester.tap(submit);
    await _settle(tester);
    final call = fake.actCalls.single;
    expect(call.id, _id);
    expect(call.action, isA<Cancel>());
    expect(call.action.reason, 'Shop closed early');
  });

  testWidgets('a quick pick fills the reason', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('action-cancel')));
    await _settle(tester);
    await tester.tap(find.text('Shop closed'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    expect(fake.actCalls.single.action.reason, 'Shop closed');
  });

  testWidgets('the rider picker greys out ineligible riders, in words, and they cannot be picked', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('action-reassign')));
    await _settle(tester);
    expect(fake.riderCalls, [_id]);
    expect(find.text('No recent location'), findsOneWidget);
    expect(find.text('On a break'), findsOneWidget);
    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Suspended'), findsOneWidget);
    expect(find.text('Not in this zone'), findsOneWidget);
    expect(find.text('Current rider'), findsOneWidget);
    expect(find.textContaining('busy (2)'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rider-33333333-3333-4333-8333-333333333305')));
    await _settle(tester);
    expect(find.text('No recent location'), findsOneWidget, reason: 'the sheet is still open');
    expect(fake.actCalls, isEmpty);
  });

  testWidgets('reassigning after pickup warns about the hand-over and sends afterPickup', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('action-reassign')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('rider-33333333-3333-4333-8333-333333333303')));
    await _settle(tester);
    expect(find.text('The food is with Ravi. They must hand it to Deepak.'), findsOneWidget);
    await tester.tap(find.text('Continue'));
    await _settle(tester);
    await tester.tap(find.text('Rider not responding'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    final a = fake.actCalls.single.action as Reassign;
    expect(a.riderId, '33333333-3333-4333-8333-333333333303');
    expect(a.afterPickup, isTrue);
    expect(a.reason, 'Rider not responding');
  });

  testWidgets('a stale refusal says so and re-fetches the order', (tester) async {
    final fake = FakeOrdersRepository()..outcomes.add(const ActionRefused('stale'));
    await _screen(tester, repo: fake);
    final before = fake.detailCalls.length;
    await tester.tap(find.byKey(const Key('action-advance')));
    await _settle(tester);
    expect(fake.actCalls.single.action, isA<Advance>());
    expect((fake.actCalls.single.action as Advance).expected, OrderStatus.onTheWay);
    expect(find.textContaining('Someone else moved this order'), findsOneWidget);
    expect(fake.detailCalls.length, greaterThan(before));
  });

  testWidgets('after a network failure, Retry resends the same clientActionId', (tester) async {
    final fake = FakeOrdersRepository()..actError = networkError();
    await _screen(tester, repo: fake);
    await tester.tap(find.byKey(const Key('action-advance')));
    await _settle(tester);
    expect(find.textContaining("Couldn't reach Deligro"), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await _settle(tester);
    expect(fake.actCalls, hasLength(2));
    expect(fake.actCalls[1].action.clientActionId, fake.actCalls[0].action.clientActionId);
  });

  testWidgets('corrections and escalations read as what changed', (tester) async {
    await _screen(tester);
    expect(find.text('Status corrected: Delivered → On the way'), findsOneWidget);
    expect(find.text('Wrong status tapped'), findsOneWidget);
    expect(find.text('Escalated to level 1'), findsOneWidget);
    expect(find.text('Order placed'), findsOneWidget);
  });

  testWidgets('a 400 about the reason reopens the dialog with the complaint, and resends anew', (tester) async {
    final fake = FakeOrdersRepository()..outcomes.add(const ActionRefused('bad_request', [], 'reason'));
    await _screen(tester, repo: fake);
    await tester.tap(find.byKey(const Key('action-cancel')));
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'zzz');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    expect(find.text("The server didn't accept this reason. Change it and send again."), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('reason-field'))).controller!.text, 'zzz');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Shop closed early');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    expect(fake.actCalls, hasLength(2));
    expect(fake.actCalls[1].action.reason, 'Shop closed early');
    expect(fake.actCalls[1].action.clientActionId, isNot(fake.actCalls[0].action.clientActionId));
  });

  testWidgets('done with no order in the answer re-fetches the order', (tester) async {
    final fake = FakeOrdersRepository()..outcomes.add(const ActionDone(null));
    await _screen(tester, repo: fake);
    final before = fake.detailCalls.length;
    await tester.tap(find.byKey(const Key('action-advance')));
    await _settle(tester);
    expect(find.text('Marked Delivered.'), findsOneWidget);
    expect(fake.detailCalls.length, before + 1);
  });

  testWidgets('a 500 action_failed offers Retry with the same clientActionId', (tester) async {
    final fake = FakeOrdersRepository()..actError = ApiException(500, 'action_failed');
    await _screen(tester, repo: fake);
    await tester.tap(find.byKey(const Key('action-advance')));
    await _settle(tester);
    expect(find.text("That change didn't go through. Try again."), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await _settle(tester);
    expect(fake.actCalls, hasLength(2));
    expect(fake.actCalls[1].action.clientActionId, fake.actCalls[0].action.clientActionId);
  });

  testWidgets('a note needs text and goes as a note', (tester) async {
    final fake = await _screen(tester);
    await tester.tap(find.byKey(const Key('action-note')));
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Customer asked to ring the bell');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    final n = fake.actCalls.single.action as Note;
    expect(n.text, 'Customer asked to ring the bell');
  });

  testWidgets('a failed first load offers Retry', (tester) async {
    final fake = FakeOrdersRepository()..detailError = networkError();
    await _screen(tester, repo: fake);
    expect(find.text('Retry'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await _settle(tester);
    expect(find.text('Paneer Tikka'), findsOneWidget);
  });

  test('push links to an order open its detail', () {
    expect(inAppPathFrom('https://deligrodelivery.ractrotech.com/admin/orders/1234abcd-0000-0000-0000-000000000000', null),
        '/orders/1234abcd-0000-0000-0000-000000000000');
    expect(inAppPathFrom(null, {'appPath': '/orders/1234abcd-0000-0000-0000-000000000000'}),
        '/orders/1234abcd-0000-0000-0000-000000000000');
    expect(inAppPathFrom(null, {'appPath': '/orders/not-an-id/x'}), '/orders');
  });
}
