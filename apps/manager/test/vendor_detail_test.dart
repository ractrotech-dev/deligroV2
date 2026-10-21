import 'package:deligro_manager/features/vendors/vendor_detail_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:deligro_manager/widgets/contact_buttons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'vp_helpers.dart';

/// The detail screen inside a router, so links can be followed; records the
/// URLs handed to the phone.
Future<({FakeVendorsRepository repo, List<Uri> opened, GoRouter router})> _detail(
  WidgetTester tester, {
  FakeVendorsRepository? repo,
  Set<String> permissions = vendorViewer,
}) async {
  final fake = repo ?? FakeVendorsRepository();
  final opened = <Uri>[];
  final router = GoRouter(initialLocation: '/more/vendors/v-1', routes: [
    GoRoute(path: '/more/vendors/:id', builder: (_, s) => VendorDetailScreen(vendorId: s.pathParameters['id']!)),
    GoRoute(path: '/orders', builder: (_, s) => Scaffold(body: Text('orders ${s.uri.query}'))),
    GoRoute(path: '/stats', builder: (_, s) => Scaffold(body: Text('stats ${s.uri.query}'))),
    GoRoute(path: '/more/tickets/:id', builder: (_, s) => Scaffold(body: Text('ticket ${s.pathParameters['id']}'))),
  ]);
  await pumpVpRouter(tester, router, overrides: [
    ...vpOverrides(vendors: fake, permissions: permissions),
    urlOpenerProvider.overrideWithValue((u) async {
      opened.add(u);
      return true;
    }),
  ]);
  return (repo: fake, opened: opened, router: router);
}

Future<void> _tapTab(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(Tab, label));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the vendor, its status reason and its rates as percentages', (tester) async {
    await _detail(tester);
    expect(find.text('Spice Hub'), findsWidgets);
    expect(find.textContaining('Documents verified'), findsOneWidget);
    expect(find.textContaining('Ravi Kumar'), findsWidgets);
    await tester.ensureVisible(find.text('6.0%'));
    expect(find.text('6.0%'), findsOneWidget);
    expect(find.text('2.0%'), findsOneWidget);
  });

  testWidgets('the Finance tab is there only when the payload carries finance', (tester) async {
    await _detail(tester);
    expect(find.widgetWithText(Tab, 'Finance'), findsOneWidget);
  });

  testWidgets('no Finance tab without finance in the payload', (tester) async {
    await _detail(tester, repo: FakeVendorsRepository(detail: fixtureVendor(finance: false)));
    expect(find.widgetWithText(Tab, 'Finance'), findsNothing);
  });

  testWidgets('only the allowed actions are offered', (tester) async {
    await _detail(tester);
    expect(find.byKey(const Key('vendor-action-suspend')), findsOneWidget);
    expect(find.byKey(const Key('vendor-action-approve')), findsNothing);
    expect(find.byKey(const Key('vendor-action-reject')), findsNothing);
    expect(find.byKey(const Key('vendor-action-reactivate')), findsNothing);
  });

  testWidgets('Suspend asks for a reason, then sends it with the status it expects', (tester) async {
    final d = await _detail(tester);
    await tester.tap(find.byKey(const Key('vendor-action-suspend')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('reason-field')), 'no');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
    await tester.tap(find.text('Hygiene complaint'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    final a = d.repo.actCalls.single.action as SuspendVendor;
    expect(a.expected, VendorStatus.active);
    expect(a.reason, 'Hygiene complaint');
  });

  testWidgets('approval refused for unverified documents offers "Approve anyway" with the same id', (tester) async {
    final pending = VendorDetail.fromJson({
      ...fixtureVendorJson(),
      'status': 'pending',
      'allowed': {'approve': true, 'reject': true},
    });
    final fake = FakeVendorsRepository(detail: pending)
      ..actOutcomes.add(const Refused('documents_unverified', ['fssai']));
    await _detail(tester, repo: fake, permissions: {...vendorViewer, 'manager.vendors.status'});
    await tester.tap(find.byKey(const Key('vendor-action-approve')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Documents verified').last);
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    expect(find.textContaining('FSSAI licence not verified'), findsOneWidget);
    await tester.tap(find.text('Approve anyway'));
    await tester.pumpAndSettle();
    final first = fake.actCalls[0].action as ApproveVendor;
    final second = fake.actCalls[1].action as ApproveVendor;
    expect(first.waiveDocuments, isFalse);
    expect(second.waiveDocuments, isTrue);
    expect(second.clientActionId, first.clientActionId);
  });

  testWidgets('a stale decision says someone else changed the vendor and re-reads it', (tester) async {
    final fake = FakeVendorsRepository()..actOutcomes.add(const Refused('stale'));
    await _detail(tester, repo: fake);
    final before = fake.detailCalls.length;
    await tester.tap(find.byKey(const Key('vendor-action-suspend')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Owner request'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Someone else changed this vendor. Showing the latest.'), findsOneWidget);
    expect(fake.detailCalls.length, greaterThan(before));
  });

  testWidgets('rejecting a document needs remarks', (tester) async {
    final d = await _detail(tester, permissions: {...vendorViewer, 'manager.vendors.status'});
    await _tapTab(tester, 'Documents');
    await tester.tap(find.byKey(const Key('doc-reject-d-2')));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Name does not match');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    final a = d.repo.actCalls.single.action as RejectDocument;
    expect(a.documentId, 'd-2');
    expect(a.reason, 'Name does not match');
  });

  testWidgets('Call dials the shop', (tester) async {
    final d = await _detail(tester);
    await tester.tap(find.byKey(const Key('contact-call')));
    await tester.pump();
    expect(d.opened.single, Uri(scheme: 'tel', path: '+917000000001'));
  });

  testWidgets('"Orders" opens the Orders tab filtered to this vendor', (tester) async {
    await _detail(tester);
    await tester.ensureVisible(find.byKey(const Key('vendor-orders-link')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('vendor-orders-link')));
    await tester.pumpAndSettle();
    expect(find.text('orders vendor=v-1'), findsOneWidget);
  });
}
