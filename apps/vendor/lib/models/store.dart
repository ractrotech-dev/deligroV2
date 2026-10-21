/// `/api/vendor/store` (src/lib/data-access/vendor-store.ts).
class StoreInfo {
  const StoreInfo({
    required this.id,
    required this.name,
    required this.tagline,
    required this.description,
    required this.cuisines,
    required this.imageUrl,
    required this.address,
    required this.landmark,
    required this.pincode,
    required this.lat,
    required this.lng,
    required this.openingTime,
    required this.closingTime,
    required this.weeklyOff,
    required this.deliveryAvailable,
    required this.selfPickup,
    required this.prepMinutes,
    required this.approved,
    required this.isOpen,
    required this.shopPhone,
    required this.closedUntil,
    required this.status,
    required this.holidays,
    required this.busyExtraMinutes,
    required this.busyUntil,
    required this.scheduleSupported,
  });

  factory StoreInfo.fromJson(Map<String, dynamic> j) {
    String? s(String k) => j[k] as String?;
    final pace = ((j['pace'] as Map?) ?? const {}).cast<String, dynamic>();
    return StoreInfo(
      id: j['id'] as String,
      name: s('name') ?? '',
      tagline: s('tagline'),
      description: s('description'),
      cuisines: [for (final c in (j['cuisines'] as List? ?? const [])) '$c'],
      imageUrl: s('imageUrl'),
      address: s('address'),
      landmark: s('landmark'),
      pincode: s('pincode'),
      lat: (j['lat'] as num?)?.toDouble(),
      lng: (j['lng'] as num?)?.toDouble(),
      openingTime: s('openingTime'),
      closingTime: s('closingTime'),
      weeklyOff: [for (final d in (j['weeklyOff'] as List? ?? const [])) '$d'],
      deliveryAvailable: j['deliveryAvailable'] != false,
      selfPickup: j['selfPickup'] == true,
      prepMinutes: (j['prepMinutes'] as num?)?.toInt(),
      approved: j['approved'] == true,
      isOpen: j['isOpen'] == true,
      shopPhone: s('shopPhone'),
      closedUntil: DateTime.tryParse(s('closedUntil') ?? '')?.toLocal(),
      status: s('status') ?? 'closed',
      holidays: [
        for (final h in (j['holidays'] as List? ?? const [])) StoreHoliday.fromJson((h as Map).cast<String, dynamic>()),
      ],
      busyExtraMinutes: (pace['extraMinutes'] as num?)?.toInt() ?? 0,
      busyUntil: DateTime.tryParse(pace['until'] as String? ?? '')?.toLocal(),
      scheduleSupported: j['scheduleSupported'] == true,
    );
  }

  final String id;
  final String name;
  final String? tagline;
  final String? description;
  final List<String> cuisines;
  final String? imageUrl;
  final String? address;
  final String? landmark;
  final String? pincode;
  final double? lat;
  final double? lng;

  /// "HH:MM", or null when the shop keeps no fixed hours.
  final String? openingTime;
  final String? closingTime;

  /// Day names ("Sunday"…), as the website stores them.
  final List<String> weeklyOff;
  final bool deliveryAvailable;
  final bool selfPickup;

  /// The shop's own prep time; null = the platform default.
  final int? prepMinutes;
  final bool approved;

  /// The owner's master switch.
  final bool isOpen;
  final String? shopPhone;

  /// Set while "closed for a while" is running.
  final DateTime? closedUntil;

  /// What customers see now: open, closed, temporarily_closed, holiday,
  /// weekly_off or outside_hours.
  final String status;
  final List<StoreHoliday> holidays;
  final int busyExtraMinutes;
  final DateTime? busyUntil;

  /// False until the server has migration 0062: no phone, holidays or timed close.
  final bool scheduleSupported;

  bool get takingOrders => status == 'open';
  bool get busy => busyExtraMinutes > 0;
}

class StoreHoliday {
  const StoreHoliday({required this.id, required this.startsOn, required this.endsOn, this.note});

  factory StoreHoliday.fromJson(Map<String, dynamic> j) => StoreHoliday(
    id: j['id'] as String,
    startsOn: DateTime.parse(j['startsOn'] as String),
    endsOn: DateTime.parse(j['endsOn'] as String),
    note: j['note'] as String?,
  );

  final String id;
  final DateTime startsOn;
  final DateTime endsOn;
  final String? note;
}

/// The whole `/api/vendor/store` answer.
class StoreState {
  const StoreState({
    required this.store,
    required this.defaultPrepMinutes,
    required this.canEdit,
    required this.canOpenClose,
    required this.canBusy,
  });

  factory StoreState.fromJson(Map<String, dynamic> j) {
    final can = ((j['can'] as Map?) ?? const {}).cast<String, dynamic>();
    return StoreState(
      store: StoreInfo.fromJson((j['store'] as Map).cast<String, dynamic>()),
      defaultPrepMinutes: (j['defaultPrepMinutes'] as num?)?.toInt() ?? 20,
      canEdit: can['edit'] != false,
      canOpenClose: can['openClose'] != false,
      canBusy: can['busy'] != false,
    );
  }

  StoreState withStore(StoreInfo s) => StoreState(
    store: s,
    defaultPrepMinutes: defaultPrepMinutes,
    canEdit: canEdit,
    canOpenClose: canOpenClose,
    canBusy: canBusy,
  );

  final StoreInfo store;
  final int defaultPrepMinutes;
  final bool canEdit;
  final bool canOpenClose;
  final bool canBusy;
}

/// The website's day names, Sunday first (`weekly_off`).
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
