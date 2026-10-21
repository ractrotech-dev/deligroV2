// Shapes for the profile, permissions, sessions, activity and settings
// screens (`/api/manager/*`, `/api/app-version`).

class PermissionInfo {
  const PermissionInfo({
    required this.key,
    required this.label,
    required this.offMeans,
    required this.on,
    required this.defaultOn,
  });

  final String key;
  final String label;
  final String offMeans;
  final bool on;
  final bool defaultOn;

  factory PermissionInfo.fromJson(Map<String, dynamic> j) => PermissionInfo(
        key: '${j['key']}',
        label: '${j['label'] ?? j['key']}',
        offMeans: '${j['offMeans'] ?? ''}',
        on: j['on'] == true,
        defaultOn: j['defaultOn'] != false,
      );
}

class SessionInfo {
  const SessionInfo({
    required this.id,
    required this.createdAt,
    required this.lastSeenAt,
    required this.userAgent,
    required this.ip,
    required this.current,
  });

  final String id;
  final DateTime? createdAt;
  final DateTime? lastSeenAt;
  final String? userAgent;
  final String? ip;
  final bool current;

  /// "Deligro Manager app", "Chrome on Windows"… from the user agent.
  String get device {
    final ua = userAgent ?? '';
    if (ua.isEmpty) return 'Unknown device';
    if (ua.contains('deligro-manager-flutter') || ua.contains('Dart/')) return 'Deligro Manager app';
    final os = ua.contains('Android')
        ? 'Android'
        : ua.contains('iPhone') || ua.contains('iPad')
            ? 'iPhone'
            : ua.contains('Windows')
                ? 'Windows'
                : ua.contains('Mac OS')
                    ? 'Mac'
                    : null;
    final browser = ua.contains('Edg/')
        ? 'Edge'
        : ua.contains('Chrome/')
            ? 'Chrome'
            : ua.contains('Firefox/')
                ? 'Firefox'
                : ua.contains('Safari/')
                    ? 'Safari'
                    : null;
    if (browser != null && os != null) return '$browser on $os';
    return browser ?? os ?? 'Unknown device';
  }

  factory SessionInfo.fromJson(Map<String, dynamic> j) => SessionInfo(
        id: '${j['id']}',
        createdAt: DateTime.tryParse('${j['createdAt']}'),
        lastSeenAt: DateTime.tryParse('${j['lastSeenAt']}'),
        userAgent: j['userAgent'] as String?,
        ip: j['ip'] as String?,
        current: j['current'] == true,
      );
}

class ActivityItem {
  const ActivityItem({
    required this.id,
    required this.action,
    required this.entityType,
    required this.entityId,
    required this.reason,
    required this.createdAt,
  });

  final int id;
  final String action;
  final String entityType;
  final String? entityId;
  final String? reason;
  final DateTime? createdAt;

  /// `order.reassign` → "Order reassign".
  String get title {
    final words = action.replaceAll(RegExp(r'[._]'), ' ').trim();
    if (words.isEmpty) return action;
    return words[0].toUpperCase() + words.substring(1);
  }

  factory ActivityItem.fromJson(Map<String, dynamic> j) => ActivityItem(
        id: (j['id'] as num?)?.toInt() ?? 0,
        action: '${j['action'] ?? ''}',
        entityType: '${j['entityType'] ?? ''}',
        entityId: j['entityId'] as String?,
        reason: j['reason'] as String?,
        createdAt: DateTime.tryParse('${j['createdAt']}'),
      );
}

class ActivityPage {
  const ActivityPage({required this.items, required this.page, required this.hasMore});
  final List<ActivityItem> items;
  final int page;
  final bool hasMore;
}

class AlertKindPref {
  const AlertKindPref({required this.kind, required this.en, required this.push});
  final String kind;
  final String en;
  final bool push;

  AlertKindPref copyWith({bool? push}) => AlertKindPref(kind: kind, en: en, push: push ?? this.push);
}

class AppVersionInfo {
  const AppVersionInfo({
    required this.updateAvailable,
    required this.forceUpdate,
    required this.latestVersionCode,
    required this.apkUrl,
    required this.notes,
  });

  final bool updateAvailable;
  final bool forceUpdate;
  final int latestVersionCode;
  final String apkUrl;
  final String notes;

  factory AppVersionInfo.fromJson(Map<String, dynamic> j) => AppVersionInfo(
        updateAvailable: j['updateAvailable'] == true,
        forceUpdate: j['forceUpdate'] == true,
        latestVersionCode: (j['latestVersionCode'] as num?)?.toInt() ?? 0,
        apkUrl: '${j['apkUrl'] ?? ''}',
        notes: '${j['releaseNotes'] ?? ''}',
      );
}
