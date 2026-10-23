import 'package:deligro_rider/models/profile.dart' as profile;
import 'package:deligro_rider/models/support.dart' as support;
import 'package:flutter_test/flutter_test.dart';

// One emergency contact model: the profile page and the SOS sheet read the
// same `profile.emergency` shape through the same class.
void main() {
  test('profile and support share one EmergencyContact', () {
    expect(profile.EmergencyContact, same(support.EmergencyContact));
  });

  test('reads profile.emergency and writes the same shape back', () {
    final p = profile.RiderProfile.fromJson({
      'emergency': {'name': 'Sunita Kumar', 'phone': '+919822012345', 'relation': 'Wife'},
    });
    expect(p.emergency.name, 'Sunita Kumar');
    expect(p.emergency.hasPhone, isTrue);
    expect(p.emergency.toJson(), {'name': 'Sunita Kumar', 'phone': '+919822012345', 'relation': 'Wife'});

    const none = profile.EmergencyContact();
    expect(none.hasPhone, isFalse);
    expect(profile.EmergencyContact.fromJson(null).toJson(), {'name': null, 'phone': null, 'relation': null});
    expect(profile.EmergencyContact.fromJson({'phone': '  '}).hasPhone, isFalse);
  });
}
