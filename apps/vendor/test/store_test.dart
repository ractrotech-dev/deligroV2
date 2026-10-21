import 'package:deligro_partner/data/store_repository.dart';
import 'package:deligro_partner/features/store/store_screen.dart';
import 'package:deligro_partner/models/store.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:deligro_partner/state/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

class MockStoreRepo extends Mock implements StoreRepository {}

Map<String, dynamic> storeJson({
  String status = 'open',
  bool isOpen = true,
  String? closedUntil,
  bool schedule = true,
  List<String> weeklyOff = const ['Tuesday'],
  int busy = 0,
}) => {
  'id': 's1',
  'slug': 'spice-hub',
  'name': 'Spice Hub Restaurant',
  'tagline': 'North Indian & tandoor',
  'description': null,
  'cuisines': ['North Indian', 'Chinese'],
  'imageUrl': null,
  'address': 'Station Road, Bemetara',
  'landmark': 'Near bus stand',
  'pincode': '491335',
  'lat': 21.71,
  'lng': 81.53,
  'openingTime': '10:00',
  'closingTime': '23:00',
  'weeklyOff': weeklyOff,
  'deliveryAvailable': true,
  'selfPickup': false,
  'prepMinutes': null,
  'approved': true,
  'isOpen': isOpen,
  'shopPhone': schedule ? '+91 98765 43210' : null,
  'closedUntil': closedUntil,
  'status': status,
  'holidays': schedule
      ? [
          {'id': 'h1', 'startsOn': '2026-11-08', 'endsOn': '2026-11-09', 'note': 'Diwali'},
        ]
      : [],
  'pace': {
    'extraMinutes': busy,
    'until': busy > 0 ? DateTime.now().add(const Duration(minutes: 40)).toUtc().toIso8601String() : null,
  },
  'scheduleSupported': schedule,
};

Map<String, dynamic> storeState({Map<String, dynamic>? store, bool canOpenClose = true, bool canEdit = true}) => {
  'store': store ?? storeJson(),
  'defaultPrepMinutes': 20,
  'can': {'edit': canEdit, 'openClose': canOpenClose, 'busy': true},
};

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
    registerFallbackValue(<String, Object?>{});
  });

  late MockStoreRepo repo;
  setUp(() => repo = MockStoreRepo());

  Future<void> open(WidgetTester t, Map<String, dynamic> json) async {
    when(repo.load).thenAnswer((_) async => StoreState.fromJson(json));
    await pumpPartner(
      t,
      child: const StoreScreen(),
      overrides: [storeRepoProvider.overrideWithValue(repo), vendorMeProvider.overrideWith(() => FixedMe(fakeMe()))],
    );
    await t.pumpAndSettle();
  }

  test('reads the store answer', () {
    final s = StoreState.fromJson(storeState());
    expect(s.store.takingOrders, isTrue);
    expect(s.store.weeklyOff, ['Tuesday']);
    expect(s.store.holidays.single.note, 'Diwali');
    expect(s.defaultPrepMinutes, 20);
    expect(s.canOpenClose, isTrue);
  });

  test('says why the shop is closed', () {
    StoreInfo s(String status) => StoreInfo.fromJson(storeJson(status: status));
    expect(statusWords(s('open')), 'Open · taking orders');
    expect(statusWords(s('holiday')), 'Closed today · holiday');
    expect(statusWords(s('weekly_off')), 'Closed today · weekly off');
    expect(statusWords(s('outside_hours')), 'Closed now · opens 10:00 AM');
    expect(statusWords(s('closed')), 'Closed · not taking orders');
  });

  testPartner('shows status, hours, holidays and details', (t) async {
    await open(t, storeState());
    expect(find.text('Open · taking orders'), findsOneWidget);
    expect(find.text('10:00 AM – 11:00 PM'), findsOneWidget);
    expect(find.text('Close shop'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Diwali'), 200);
    expect(find.text('Diwali'), findsOneWidget);
    await t.scrollUntilVisible(find.text('+91 98765 43210'), 200);
    expect(find.text('Station Road, Bemetara, Near bus stand, 491335'), findsOneWidget);
  });

  testPartner('closes for an hour', (t) async {
    when(() => repo.setOpen(false, closeForMinutes: 60)).thenAnswer(
      (_) async => StoreInfo.fromJson(storeJson(status: 'temporarily_closed', closedUntil: '2030-01-01T10:00:00Z')),
    );
    await open(t, storeState());
    await t.tap(find.text('Close shop'));
    await t.pumpAndSettle();
    expect(find.text('Until I open it again'), findsOneWidget);
    await t.tap(find.text('For 1 hour'));
    await t.pumpAndSettle();
    verify(() => repo.setOpen(false, closeForMinutes: 60)).called(1);
    expect(find.text('Open shop now'), findsOneWidget);
  });

  testPartner('without 0062 there is no timed close and no holidays', (t) async {
    when(() => repo.setOpen(false))
        .thenAnswer((_) async => StoreInfo.fromJson(storeJson(status: 'closed', isOpen: false, schedule: false)));
    await open(t, storeState(store: storeJson(schedule: false)));
    expect(find.text('Holidays'.toUpperCase()), findsNothing);
    await t.tap(find.text('Close shop'));
    await t.pumpAndSettle();
    expect(find.text('For 1 hour'), findsNothing);
    await t.tap(find.text('Until I open it again'));
    await t.pumpAndSettle();
    verify(() => repo.setOpen(false)).called(1);
  });

  testPartner('a weekly-off chip saves the new set', (t) async {
    when(() => repo.update(any()))
        .thenAnswer((_) async => StoreInfo.fromJson(storeJson(weeklyOff: ['Sunday', 'Tuesday'])));
    await open(t, storeState());
    await t.tap(find.widgetWithText(FilterChip, 'Sun'));
    await t.pumpAndSettle();
    final sent = verify(() => repo.update(captureAny())).captured.single as Map<String, Object?>;
    expect((sent['weeklyOff'] as List).toSet(), {'Tuesday', 'Sunday'});
  });

  testPartner('busy mode adds minutes', (t) async {
    when(() => repo.setBusy(20)).thenAnswer((_) async {});
    await open(t, storeState());
    await t.tap(find.widgetWithText(ChoiceChip, '+20 min'));
    await t.pumpAndSettle();
    verify(() => repo.setBusy(20)).called(1);
  });

  testPartner('when Deligro controls opening, there is no switch', (t) async {
    await open(t, storeState(canOpenClose: false));
    expect(find.text('Close shop'), findsNothing);
    expect(find.text('Deligro controls when this shop opens and closes.'), findsOneWidget);
  });
}
