/// What the "Delivery instructions" sheet turns into on the order.
///
/// The structured parts (flat, entry code, floor, building) are still part of
/// *where* — they ride on the address line. The free-text note for the courier
/// is not: it goes to the server as `instructions`, which stores it apart from
/// the address (`orders.delivery_instructions`) and shows it to the rider as
/// instructions.
library;

/// `MAX_INSTRUCTIONS_LENGTH` in src/lib/orders/instructions.ts. The server
/// refuses more with `instructions_too_long`; the field stops short of it.
const maxDeliveryInstructions = 300;

/// The saved address plus the details typed for this order. Never the note.
String deliveryAddressLine(
  String base, {
  String apartment = '',
  String entry = '',
  String floor = '',
  String building = '',
}) =>
    [
      base,
      apartment.trim(),
      if (entry.trim().isNotEmpty) 'Entry ${entry.trim()}',
      if (floor.trim().isNotEmpty) 'Floor ${floor.trim()}',
      building.trim(),
    ].where((s) => s.isNotEmpty).join(', ');

/// The note for the courier, trimmed and capped; null when there is none.
String? deliveryInstructions(String note) {
  final text = note.trim();
  if (text.isEmpty) return null;
  final runes = text.runes;
  return runes.length <= maxDeliveryInstructions
      ? text
      : String.fromCharCodes(runes.take(maxDeliveryInstructions));
}
