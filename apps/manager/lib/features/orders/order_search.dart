/// What the Orders search box can look for, mirroring what the server takes
/// (src/lib/ops/order-query.ts parseOrderSearch): an order code or ID, a customer
/// or shop name, or a whole phone number.
const orderSearchHint = 'Order code, customer, shop or phone';

final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
final _code = RegExp(r'^[0-9a-fA-F]{4,8}$');
final _phone = RegExp(r'^(\+91)?\d{10}$');
final _numeric = RegExp(r'^[+\d\s-]+$');
final _notSearched = RegExp(r'[\\%_*\x00-\x1f\x7f]');

bool _looksLikeCode(String text) => _code.hasMatch(text.replaceFirst('#', '').replaceAll(RegExp(r'\s+'), ''));

/// A whole phone number, and not a code or an ID. Each such search is audited on
/// the server, so the list does not repeat it on its 10-second refresh.
bool isPhoneSearch(String? text) {
  final t = text?.trim() ?? '';
  if (t.isEmpty || _uuid.hasMatch(t) || _looksLikeCode(t)) return false;
  return _phone.hasMatch(t.replaceAll(RegExp(r'[\s-]'), ''));
}

/// In plain words, why [text] can't be searched as typed; null when it can.
String? orderSearchProblem(String text, {required bool canSearchPhone}) {
  final t = text.trim();
  if (t.isEmpty || _uuid.hasMatch(t) || _looksLikeCode(t)) return null;
  if (isPhoneSearch(t)) {
    return canSearchPhone
        ? null
        : 'Searching by phone needs the Contact customers permission. Try the order code, customer name or shop.';
  }
  if (_numeric.hasMatch(t)) return 'Type the 4 to 8 character order code, or the full 10-digit phone number.';
  final cleaned = t.replaceAll(_notSearched, '').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (cleaned.length < 2) return 'Type at least 2 letters of the name, or the order code.';
  if (cleaned.length > 60) return 'That is too long. Type up to 60 characters of the name.';
  return null;
}
