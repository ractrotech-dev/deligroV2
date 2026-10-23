import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/customers/customer_detail_screen.dart';
import 'package:deligro_manager/features/customers/customers_screen.dart';
import 'package:deligro_manager/features/customers/retention_screen.dart';
import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_marketing_offers_customers.dart';
import 'p7_helpers.dart';

const contactPerms = {...marketer, 'manager.customers.contact', 'manager.customers.suspend'};

void main() {
  test('an Orders link can carry a customer filter', () {
    final f = OrderFilters.fromUri(Uri.parse('/orders?customer=c-1&customerName=Priya'));
    expect(f.customerId, 'c-1');
    expect(f.customerName, 'Priya');
    expect(f.toQuery()['customer'], 'c-1');
    expect(f.toQuery().containsKey('customerName'), isFalse);
    expect(f.narrowed, isTrue);
  });

  testWidgets('no phone search without the contact permission', (tester) async {
    await pumpP7(tester, const CustomersScreen());
    await settle(tester);
    expect(find.byKey(const Key('customers-phone')), findsNothing);
    expect(find.text('Priya S.'), findsOneWidget);
    expect(find.text('••••••3210'), findsOneWidget);
  });

  testWidgets('phone search appears with the permission and is sent as phone=', (tester) async {
    final repo = FakeCustomersRepository();
    await pumpP7(tester, const CustomersScreen(), customers: repo, permissions: contactPerms);
    await settle(tester);
    expect(find.byKey(const Key('customers-phone')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('customers-phone')), '9876543210');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await settle(tester, 8);
    expect(repo.queries.last.phone, '9876543210');
  });

  testWidgets('reveal asks a reason and shows the number only after the call returns', (tester) async {
    final repo = FakeCustomersRepository();
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    expect(find.text('+919876543210'), findsNothing);
    await tester.tap(find.byKey(const Key('contact-reveal')));
    await settle(tester);
    expect(tester.widget<FilledButton>(find.byKey(const Key('reveal-submit'))).onPressed, isNull);
    await tester.tap(find.byKey(const Key('reveal-reason-refund')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reveal-submit')));
    await settle(tester);
    expect(repo.reveals.single.$2, ContactReason.refund);
    expect(find.text('+919876543210'), findsOneWidget);
  });

  Future<void> revealWithRefund(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('contact-reveal')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('reveal-reason-refund')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reveal-submit')));
    await settle(tester);
  }

  testWidgets('a revealed number hides itself after 30 seconds, and can be hidden at once', (tester) async {
    final repo = FakeCustomersRepository();
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    await revealWithRefund(tester);
    expect(find.text('+919876543210'), findsOneWidget);
    // (settle already spent ~1.2 s of the 30.) Still there at ~29 s, gone by 31 s.
    await tester.pump(const Duration(seconds: 27));
    expect(find.text('+919876543210'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('+919876543210'), findsNothing);
    expect(find.byKey(const Key('contact-reveal')), findsOneWidget);

    await revealWithRefund(tester);
    expect(find.text('+919876543210'), findsOneWidget);
    await tester.tap(find.byKey(const Key('contact-hide')));
    await tester.pump();
    expect(find.text('+919876543210'), findsNothing);
  });

  testWidgets('a revealed number hides when the app leaves the screen', (tester) async {
    final repo = FakeCustomersRepository();
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    await revealWithRefund(tester);
    expect(find.text('+919876543210'), findsOneWidget);
    // What the platform sends when the manager switches away and comes back.
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pump();
    expect(find.text('+919876543210'), findsNothing);
    expect(find.byKey(const Key('contact-reveal')), findsOneWidget);
  });

  testWidgets('a customer with only an email can be revealed', (tester) async {
    final repo = FakeCustomersRepository()
      ..detailValue = CustomerDetail.fromJson(
          Map<String, dynamic>.from(p7('customer_detail')['customer'] as Map)..['phoneMasked'] = null)
      ..contact = const ContactReveal(email: 'asha@example.com');
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    expect(find.text('No phone on file'), findsOneWidget);
    expect(find.byKey(const Key('contact-reveal')), findsOneWidget);
    await revealWithRefund(tester);
    expect(find.text('asha@example.com'), findsOneWidget);
  });

  testWidgets('a customer with no contact details says so', (tester) async {
    final repo = FakeCustomersRepository()..contact = const ContactReveal();
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    await revealWithRefund(tester);
    expect(find.text('No contact details on file.'), findsOneWidget);
  });

  testWidgets('suspend explains what it means, and effect_failed says the block did not apply', (tester) async {
    final repo = FakeCustomersRepository()..actFaults.add(ApiException(502, 'effect_failed', body: {'error': 'effect_failed'}));
    await pumpP7(tester, const CustomerDetailScreen(customerId: 'c-1'), customers: repo, permissions: contactPerms);
    await settle(tester);
    await tester.scrollUntilVisible(find.byKey(const Key('customer-suspend')), 300, scrollable: find.byType(Scrollable).first);
    await tester.ensureVisible(find.byKey(const Key('customer-suspend')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('customer-suspend')));
    await settle(tester);
    expect(find.textContaining('cannot sign in or order'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Repeated fake orders');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    expect(repo.actions.single.$2.kind, CustomerActionKind.suspend);
    expect(repo.actions.single.$2.expected, CustomerStatus.active);
    expect(find.text('Saved, but the sign-in block failed — try again.'), findsOneWidget);
  });

  testWidgets('retention shows a dash for cohorts not old enough', (tester) async {
    await pumpP7(tester, const RetentionScreen());
    await settle(tester);
    expect(find.text('38.2%'), findsOneWidget);
    expect(find.byKey(const Key('cohort-2026-10-r30')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('cohort-2026-10-r30'))).data, '—');
    expect(tester.widget<Text>(find.byKey(const Key('cohort-2026-05-r90'))).data, '55.8%');
  });
}
