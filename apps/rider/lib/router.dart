import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/login_screen.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// Only the placeholder login route exists in the scaffold; the real login,
/// session gate and rider screens are added by the tasks that follow.
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/login',
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
    ],
  );
});
