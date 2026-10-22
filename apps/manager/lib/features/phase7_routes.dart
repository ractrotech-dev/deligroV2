import 'package:go_router/go_router.dart';

import '../router.dart' show rootNavigatorKey;
import 'marketing/marketing_screen.dart';
import 'marketing/request_detail_screen.dart';
import 'marketing/request_new_screen.dart';

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
        ],
      ),
    ];
