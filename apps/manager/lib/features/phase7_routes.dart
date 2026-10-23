import 'package:go_router/go_router.dart';

import '../router.dart' show rootNavigatorKey;
import 'customers/customer_detail_screen.dart';
import 'customers/customers_screen.dart';
import 'customers/retention_screen.dart';
import 'marketing/campaign_detail_screen.dart';
import 'marketing/campaign_form_screen.dart';
import 'marketing/marketing_screen.dart';
import 'marketing/request_detail_screen.dart';
import 'marketing/request_new_screen.dart';
import 'offers/offer_detail_screen.dart';
import 'offers/offer_form_screen.dart';
import 'offers/offers_screen.dart';

/// Marketing (§8), offers (§9) and customers (§10) — the routes under
/// `/more`, kept in their own list so the router changes by one line.
List<RouteBase> phase7Routes() => [
      GoRoute(
        path: 'marketing',
        parentNavigatorKey: rootNavigatorKey,
        builder: (_, state) => MarketingScreen(query: state.uri),
        routes: [
          // Before ':id', or "new" would read as a request id.
          GoRoute(
            path: 'requests/new',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, _) => const RequestNewScreen(),
          ),
          GoRoute(
            path: 'requests/:id',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, state) => RequestDetailScreen(requestId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: 'campaigns/new',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, _) => const CampaignFormScreen(),
          ),
          GoRoute(
            path: 'campaigns/:id',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, state) => CampaignDetailScreen(campaignId: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: 'offers',
        parentNavigatorKey: rootNavigatorKey,
        builder: (_, state) => OffersScreen(query: state.uri),
        routes: [
          GoRoute(path: 'new', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const OfferFormScreen()),
          GoRoute(
            path: ':code',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, state) => OfferDetailScreen(code: state.pathParameters['code']!),
          ),
        ],
      ),
      GoRoute(
        path: 'customers',
        parentNavigatorKey: rootNavigatorKey,
        builder: (_, state) => CustomersScreen(query: state.uri),
        routes: [
          // Before ':id', or "retention" would read as a customer id.
          GoRoute(path: 'retention', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const RetentionScreen()),
          GoRoute(
            path: ':id',
            parentNavigatorKey: rootNavigatorKey,
            builder: (_, state) => CustomerDetailScreen(customerId: state.pathParameters['id']!),
          ),
        ],
      ),
    ];
