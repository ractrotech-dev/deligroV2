/// Lenient readers for the manager API's JSON. A field of the wrong type
/// reads as its empty value rather than throwing, so a server that grows or
/// reshapes a field degrades one row, not the screen.
library;

DateTime? jDate(Object? v) => v is String ? DateTime.tryParse(v) : null;
int jInt(Object? v) => v is num ? v.round() : 0;
int? jIntOrNull(Object? v) => v is num ? v.round() : null;
double jDouble(Object? v) => v is num ? v.toDouble() : 0;
double? jDoubleOrNull(Object? v) => v is num ? v.toDouble() : null;
String? jStr(Object? v) => v is String ? v : null;
String jStrOr(Object? v, [String fallback = '']) => v is String ? v : fallback;
bool jBool(Object? v) => v == true;
Map<String, dynamic>? jMap(Object? v) => v is Map ? v.cast<String, dynamic>() : null;
List<Map<String, dynamic>> jMaps(Object? v) =>
    [for (final e in (v is List ? v : const [])) if (e is Map) e.cast<String, dynamic>()];
List<String> jStrings(Object? v) => [for (final e in (v is List ? v : const [])) if (e is String) e];

/// The enum value whose wire name is [wire], else [unknown].
T jEnum<T extends Enum>(List<T> values, Object? wire, T unknown, [String Function(T)? toWire]) {
  if (wire is! String) return unknown;
  for (final v in values) {
    if ((toWire?.call(v) ?? v.name) == wire) return v;
  }
  return unknown;
}

/// `{ "id", "name" }` as a pair; null when absent.
({String id, String name})? jRef(Object? v) {
  final m = jMap(v);
  if (m == null) return null;
  return (id: jStrOr(m['id']), name: jStrOr(m['name']));
}
