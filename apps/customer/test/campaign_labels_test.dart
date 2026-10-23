// Phase 7 (0160): featured shops and sponsored dishes are labelled, ordered
// and tracked the way the website does it.
import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/data/campaign_repository.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/state/campaigns.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:deligro_customer/widgets/restaurant_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _client = SupabaseClient('http://localhost:1', 'test-key', authOptions: const AuthClientOptions(autoRefreshToken: false));

final _shop = Restaurant.fromRow({
  'id': 'r1', 'slug': 'spice-hub', 'name': 'Spice Hub', 'tagline': '', 'is_open': true, 'cuisines': ['Rolls'],
  'rating': 4.4, 'rating_count': 40, 'eta_min': 20, 'eta_max': 30, 'image_url': '', 'menu_items': const [],
});

class _RecordingCampaigns extends CampaignRepository {
  _RecordingCampaigns() : super(ApiClient(_client.auth));
  final sent = <String>[];
  @override
  Future<LivePlacements> live() async => LivePlacements.empty;
  @override
  Future<void> track(String campaignId, String kind, {String? itemId}) async => sent.add('$kind:$campaignId');
}

Future<void> _pumpCard(WidgetTester tester, SharedPreferences prefs, LivePlacements placements, _RecordingCampaigns repo) async {
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      supabaseProvider.overrideWithValue(_client),
      livePlacementsProvider.overrideWith((_) async => placements),
      campaignRepoProvider.overrideWithValue(repo),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(body: SizedBox(width: 360, child: RestaurantCard(restaurant: _shop))),
    ),
  ));
  await tester.pump();
  await tester.pump();
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);
  late SharedPreferences prefs;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  test('the overlay puts a featured shop at its slot and moves pins down', () {
    final p = effectivePositions({'A': 1, 'B': 2}, {'C': 1});
    expect(p, {'C': 1, 'A': 2, 'B': 3});
    expect(effectivePositions({'A': 5}, {}), {'A': 5});
  });

  test('live placements parse from /api/campaigns/live', () {
    final p = LivePlacements.fromJson({
      'featured': [{'campaignId': 'c1', 'restaurantId': 'r1', 'slot': 2}],
      'sponsored': [{'campaignId': 'c2', 'menuItemId': 'm1'}],
    });
    expect(p.featuredFor('r1'), 'c1');
    expect(p.featured['r1']!.slot, 2);
    expect(p.sponsoredFor('m1'), 'c2');
    expect(p.featuredFor('nope'), isNull);
  });

  testWidgets('a featured shop is labelled and reports one impression', (tester) async {
    final repo = _RecordingCampaigns();
    await _pumpCard(tester, prefs, LivePlacements(featured: {'r1': (campaignId: 'c1', slot: 1)}), repo);
    expect(find.text('Featured'), findsOneWidget);
    expect(repo.sent.where((s) => s == 'impression:c1').length, 1);
  });

  testWidgets('an ordinary shop carries no label and sends nothing', (tester) async {
    final repo = _RecordingCampaigns();
    await _pumpCard(tester, prefs, LivePlacements.empty, repo);
    expect(find.text('Featured'), findsNothing);
    expect(repo.sent, isEmpty);
  });

  test('the tracker reports one impression per campaign, however often it is shown', () {
    final repo = _RecordingCampaigns();
    final tracker = CampaignTracker(repo)
      ..impression('c1')
      ..impression('c1')
      ..click('c1');
    expect(tracker, isNotNull);
    expect(repo.sent, ['impression:c1', 'click:c1']);
  });
}
