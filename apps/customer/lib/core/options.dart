/// Sizes, add-ons, dish schedules and shop status (migration 0062), the way
/// the website does them (src/lib/orders/order-options.ts). The database's
/// order-line guard is the authority: it prices every line itself and refuses
/// an invalid choice; these mirror its rules so the app can say so first.
library;

class MenuOption {
  const MenuOption({required this.id, required this.name, required this.price, this.available = true});

  factory MenuOption.fromRow(Map<String, dynamic> r) => MenuOption(
        id: '${r['id']}',
        name: '${r['name'] ?? ''}',
        price: (r['price'] as num?)?.round() ?? 0,
        available: r['available'] != false,
      );

  final String id;
  final String name;
  final int price;
  final bool available;
}

class MenuAddonGroup {
  const MenuAddonGroup({
    required this.id,
    required this.name,
    required this.minSelect,
    required this.maxSelect,
    required this.addons,
  });

  factory MenuAddonGroup.fromRow(Map<String, dynamic> r) => MenuAddonGroup(
        id: '${r['id']}',
        name: '${r['name'] ?? ''}',
        minSelect: (r['min_select'] as num?)?.toInt() ?? 0,
        maxSelect: (r['max_select'] as num?)?.toInt() ?? 1,
        addons: sortedRows(r['menu_item_addons']).map(MenuOption.fromRow).toList(),
      );

  final String id;
  final String name;
  final int minSelect;
  final int maxSelect;
  final List<MenuOption> addons;
}

/// Embedded rows in their `sort_order`.
List<Map<String, dynamic>> sortedRows(Object? raw) {
  final rows = [for (final r in (raw as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
  rows.sort((a, b) => ((a['sort_order'] as num?) ?? 0).compareTo((b['sort_order'] as num?) ?? 0));
  return rows;
}

/// What the customer picked: one size (when the dish has sizes) and add-ons.
class OptionChoice {
  const OptionChoice({this.variantId, this.addonIds = const []});

  final String? variantId;
  final List<String> addonIds;

  static const none = OptionChoice();

  bool get isEmpty => variantId == null && addonIds.isEmpty;
}

/// The parts of a dish the rules need.
abstract interface class OptionChoiceItem {
  int get effective;
  List<MenuOption> get variants;
  List<MenuAddonGroup> get addonGroups;
}

bool hasOptions(OptionChoiceItem item) => item.variants.isNotEmpty || item.addonGroups.isNotEmpty;

/// Why a choice can't be ordered, or null when it can.
sealed class ChoiceProblem {
  const ChoiceProblem();
}

class ChooseSize extends ChoiceProblem {
  const ChooseSize();
}

class InvalidChoice extends ChoiceProblem {
  const InvalidChoice();
}

class GroupMin extends ChoiceProblem {
  const GroupMin(this.group, this.n);
  final String group;
  final int n;
}

class GroupMax extends ChoiceProblem {
  const GroupMax(this.group, this.n);
  final String group;
  final int n;
}

ChoiceProblem? choiceProblem(OptionChoiceItem item, OptionChoice choice) {
  final live = item.variants.where((v) => v.available);
  if (choice.variantId == null) {
    if (live.isNotEmpty) return const ChooseSize();
  } else if (!live.any((v) => v.id == choice.variantId)) {
    return const InvalidChoice();
  }
  final groupOf = <String, String>{
    for (final g in item.addonGroups)
      for (final a in g.addons)
        if (a.available) a.id: g.id,
  };
  if (choice.addonIds.any((id) => !groupOf.containsKey(id)) || choice.addonIds.toSet().length != choice.addonIds.length) {
    return const InvalidChoice();
  }
  for (final g in item.addonGroups) {
    final n = choice.addonIds.where((id) => groupOf[id] == g.id).length;
    if (n < g.minSelect) return GroupMin(g.name, g.minSelect);
    if (n > g.maxSelect) return GroupMax(g.name, g.maxSelect);
  }
  return null;
}

/// The size's price (or the dish's effective price), plus the add-ons.
int choicePrice(OptionChoiceItem item, OptionChoice choice) {
  final variant = item.variants.where((v) => v.id == choice.variantId).firstOrNull;
  final addons = item.addonGroups.expand((g) => g.addons).where((a) => choice.addonIds.contains(a.id));
  return (variant?.price ?? item.effective) + addons.fold(0, (s, a) => s + a.price);
}

/// "Full · Extra cheese, Mayo"; empty for a dish ordered as it is.
String choiceLabel(OptionChoiceItem item, OptionChoice choice) {
  final variant = item.variants.where((v) => v.id == choice.variantId).firstOrNull?.name;
  final addons = item.addonGroups.expand((g) => g.addons).where((a) => choice.addonIds.contains(a.id)).map((a) => a.name);
  return [?variant, if (addons.isNotEmpty) addons.join(', ')].join(' · ');
}

/// One basket line per dish per choice; a plain dish's key is its id.
String lineKey(String itemId, [OptionChoice choice = OptionChoice.none]) {
  if (choice.isEmpty) return itemId;
  final addons = [...choice.addonIds]..sort();
  return '$itemId|${choice.variantId ?? ''}|${addons.join(',')}';
}

/// Is a dish offered at [at] by its own schedule? IST, like the guard; a
/// window that closes before it opens runs past midnight.
bool offeredNow({List<int>? days, String? from, String? to, DateTime? at}) {
  final ist = (at ?? DateTime.now()).toUtc().add(const Duration(minutes: 330));
  final day = ist.weekday % 7; // Dart: Monday = 1 … Sunday = 7 → 0
  if (days != null && days.isNotEmpty && !days.contains(day)) return false;
  if (from != null && to != null && from != to) {
    int m(String t) => int.parse(t.substring(0, 2)) * 60 + int.parse(t.substring(3, 5));
    final now = ist.hour * 60 + ist.minute, f = m(from), t = m(to);
    return f < t ? now >= f && now < t : now >= f || now < t;
  }
  return true;
}

/// "09:30" → "9:30 AM".
String? clockLabel(String? hhmm) {
  if (hhmm == null || hhmm.length < 5) return null;
  final h = int.tryParse(hhmm.substring(0, 2));
  if (h == null) return null;
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:${hhmm.substring(3, 5)} ${h >= 12 ? 'PM' : 'AM'}';
}

/// Why a closed shop is closed, in the website's words (closedMessage).
String closedMessage(String? status, String? openingTime) {
  final opens = clockLabel(openingTime);
  return switch (status) {
    'temporarily_closed' => 'This shop has paused orders for a short while. Try again a little later.',
    'holiday' => 'This shop is closed today for a holiday.',
    'weekly_off' => 'This shop is closed today.',
    'outside_hours' => opens == null ? 'This shop is closed right now.' : 'This shop is closed right now. It opens at $opens.',
    _ => 'This shop reopens when they\'re ready — try again a bit later.',
  };
}

/// The add-on names on an order line's `options` snapshot (the size is
/// already in the line's name).
List<String> chosenAddons(Object? options) {
  if (options is! Map) return const [];
  final addons = options['addons'];
  if (addons is! List) return const [];
  return [
    for (final a in addons)
      if (a is Map && a['name'] is String && (a['name'] as String).isNotEmpty) a['name'] as String,
  ];
}
