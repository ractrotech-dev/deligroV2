class SavedAddress {
  const SavedAddress({
    required this.id,
    required this.label,
    required this.line,
    required this.lat,
    required this.lng,
    required this.isDefault,
  });

  final String id;
  final String label;
  final String line;
  final double? lat;
  final double? lng;
  final bool isDefault;

  bool get pinned => lat != null && lng != null;

  /// `/api/addresses` returns camelCase.
  factory SavedAddress.fromApi(Map<String, dynamic> j) => SavedAddress(
        id: '${j['id']}',
        label: '${j['label'] ?? 'Home'}',
        line: '${j['line'] ?? ''}',
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        isDefault: j['isDefault'] == true,
      );
}
