/// The rider's emergency contact: `GET /api/rider/profile` -> `profile.emergency`.
/// One model for the profile page and the SOS sheet; `models/profile.dart` and
/// `models/support.dart` both export it.
library;

String? _nonEmpty(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;

class EmergencyContact {
  const EmergencyContact({this.name, this.phone, this.relation});

  final String? name;
  final String? phone;
  final String? relation;

  bool get hasPhone => (phone ?? '').trim().isNotEmpty;

  factory EmergencyContact.fromJson(Object? j) {
    final m = j is Map ? j : const {};
    return EmergencyContact(
      name: _nonEmpty(m['name']),
      phone: _nonEmpty(m['phone']),
      relation: _nonEmpty(m['relation']),
    );
  }

  Map<String, dynamic> toJson() => {'name': name, 'phone': phone, 'relation': relation};
}
