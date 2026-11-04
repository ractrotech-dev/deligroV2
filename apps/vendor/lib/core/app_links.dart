import 'package:go_router/go_router.dart';

/// Links the server used to send, kept in the inbox of every shop: they point at
/// pages that never existed under those names.
String currentAppPath(String path) {
  final dish = RegExp(r'^/menu/([^/?#]+)').firstMatch(path);
  if (dish != null) return '/more/products/${dish.group(1)}';
  return switch (path) {
    '/menu' => '/more/products',
    '/more/shop' || '/more/shop/documents' => '/more/store',
    '/more/payments' => '/payments',
    _ => path,
  };
}

/// The bottom bar's own screens: going there switches tab. Everything else
/// opens over what is on screen, so Back returns to it.
const _tabRoots = {'/', '/orders', '/reports', '/payments', '/more'};

/// Opens a link from a notification row or a push tap. Anything the app has no
/// page for lands on the router's friendly error page.
void openAppLink(GoRouter router, String link) {
  final uri = Uri.tryParse(link);
  final path = currentAppPath(uri?.path ?? link);
  final query = uri != null && uri.hasQuery ? '?${uri.query}' : '';
  if (_tabRoots.contains(path)) {
    router.go('$path$query');
  } else {
    router.push('$path$query');
  }
}
