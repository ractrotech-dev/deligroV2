// Fixture profile for the debug-only preview. Imported only from
// state/profile.dart behind `fixturesEnabled`, which is a compile-time false
// in a release build, so none of this is in the release app.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/document_file.dart';
import '../../core/money.dart';
import '../../models/profile.dart';
import '../profile_repository.dart';

/// Which rider a fixture session is (`--dart-define=FIXTURE_PROFILE=`):
/// `mixed` (documents in every state, two requests waiting), `verified`
/// (everything in order) or `new` (nothing uploaded yet).
const String fixtureProfileScenario = String.fromEnvironment('FIXTURE_PROFILE', defaultValue: 'mixed');

/// A licence number only the fixtures carry, so a release build can be
/// searched for it to prove the fixtures are not in it.
const fixtureProfileMarker = 'FXT-DL-90417';

// A 96x60 placeholder card, standing in for a document's picture.
const _placeholderPng =
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAfElEQVR42u3YQQkAIBAAQW1jCEOYz36CDzGDDXyLN7AJ5rlp9KxLCQEgQIAAAQIUDmivGSpAgAABAgQoOlCp7YUAAQIECBAgQIAAAQIECBAgQID8IECAAAECBAgQIECAAAECBAgQIECAAAECBAjQt0ACBAgQIECAAH0OdAD2hqM6uWqNzQAAAABJRU5ErkJggg==';

String _last4(Object? v) {
  final s = '$v';
  return s.length > 4 ? s.substring(s.length - 4) : s;
}

/// [ProfileRepository] over in-memory state. Requests wait for Deligro the way
/// the server holds them: the payout account always, name/licence/vehicle once
/// the rider is verified.
class FixtureProfileRepository implements ProfileRepository {
  FixtureProfileRepository._(this._scenario, this._now) {
    _build();
  }

  factory FixtureProfileRepository.create({
    String scenario = fixtureProfileScenario,
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    assert(!kReleaseMode, 'the fixture backend must never be built in a release build');
    if (releaseMode) {
      throw StateError('the fixture backend is not available in a release build');
    }
    return FixtureProfileRepository._(scenario, now ?? DateTime.now());
  }

  final String _scenario;
  final DateTime _now;
  var _seq = 0;

  late Map<String, dynamic> _p;
  final _docs = <Map<String, dynamic>>[];
  final _pending = <Map<String, dynamic>>[];
  final _history = <Map<String, dynamic>>[];

  String get _today => istDayKey(_now);

  Map<String, dynamic> _doc(
    String type, {
    String status = 'verified',
    String? number,
    int? expiresInDays,
    String? remarks,
  }) {
    final expiresOn = expiresInDays == null ? null : addDays(_today, expiresInDays);
    return {
      'id': 'doc-${++_seq}',
      'type': type,
      'numberMasked': number,
      'expiresOn': expiresOn,
      'daysLeft': expiresInDays,
      'status': status,
      'remarks': remarks,
      'uploadedAt': _now.subtract(const Duration(days: 30)).toUtc().toIso8601String(),
    };
  }

  void _build() {
    _p = {
      'riderCode': 'DR-0042',
      'name': 'Ravi Kumar',
      'phone': '+919876543210',
      'avatarUrl': null,
      'address': {'line': '14 Shivaji Nagar', 'city': 'Pune', 'pincode': '411005'},
      'vehicle': {'type': 'ev_bike', 'owner': 'deligro', 'registration': 'MH12EV4821'},
      'licence': {'number': fixtureProfileMarker, 'expiresOn': addDays(_today, -3)},
      'emergency': {'name': 'Sunita Kumar', 'phone': '+919822012345', 'relation': 'Wife'},
      'payoutAccount': {'kind': 'bank', 'masked': 'XXXX4521'},
      'verification': 'pending',
    };
    switch (_scenario) {
      case 'verified':
        _p['verification'] = 'verified';
        (_p['licence'] as Map)['expiresOn'] = addDays(_today, 420);
        _docs.addAll([
          _doc('aadhaar', number: 'XXXX-XXXX-4821'),
          _doc('driving_licence', number: 'XXXX0417', expiresInDays: 420),
          _doc('photo'),
        ]);
      case 'new':
        _p['verification'] = 'unverified';
        _p['payoutAccount'] = null;
        _p['address'] = {'line': null, 'city': null, 'pincode': null};
        _p['emergency'] = {'name': null, 'phone': null, 'relation': null};
        _p['licence'] = {'number': null, 'expiresOn': null};
        _p['vehicle'] = {'type': null, 'owner': 'deligro', 'registration': null};
      default:
        _docs.addAll([
          _doc('aadhaar', number: 'XXXX-XXXX-4821'),
          _doc('driving_licence', status: 'expired', number: 'XXXX0417', expiresInDays: -3),
          _doc('photo', status: 'rejected', remarks: 'The photo is blurry. Take it again in good light.'),
          _doc('pan', status: 'pending', number: 'XXXX1234'),
        ]);
        _pending.addAll([
          {
            'id': 'chg-1',
            'field': 'full_name',
            'createdAt': _now.subtract(const Duration(hours: 5)).toUtc().toIso8601String(),
            'summary': 'Ravi Kumar Yadav',
          },
          {
            'id': 'chg-2',
            'field': 'payout_account',
            'createdAt': _now.subtract(const Duration(days: 1)).toUtc().toIso8601String(),
            'summary': 'XXXX9921',
          },
        ]);
        _history.add({
          'id': 'chg-0',
          'field': 'vehicle',
          'status': 'rejected',
          'createdAt': _now.subtract(const Duration(days: 9)).toUtc().toIso8601String(),
          'decidedAt': _now.subtract(const Duration(days: 8)).toUtc().toIso8601String(),
          'decisionNote': 'The registration number does not match the RC.',
          'summary': 'EV bike · MH12EV9999',
        });
    }
  }

  @override
  Future<RiderProfile> profile() async => RiderProfile.fromJson({
    ..._p,
    'documents': _docs,
    'pendingChanges': _pending,
    'needsAttention': _scenario != 'verified',
  });

  @override
  Future<List<ChangeRequestView>> changeRequests() async => [
    for (final c in [..._pending.map((p) => {...p, 'status': 'pending'}), ..._history])
      ChangeRequestView.fromJson(c),
  ];

  @override
  Future<void> saveDirect({Map<String, Object?>? address, Map<String, Object?>? emergency}) async {
    if (address != null) {
      _p['address'] = {...(_p['address'] as Map), ...address};
    }
    if (emergency != null) {
      _p['emergency'] = {...(_p['emergency'] as Map), ...emergency};
    }
  }

  @override
  Future<ChangeOutcome> requestChange(String field, Map<String, Object?> value) async {
    if (_pending.any((c) => c['field'] == field)) throw ApiException(409, 'duplicate_pending');
    final waits = field == 'payout_account' || _p['verification'] == 'verified';
    if (waits) {
      _pending.add({
        'id': 'chg-${++_seq}',
        'field': field,
        'createdAt': _now.toUtc().toIso8601String(),
        'summary': _summary(field, value),
      });
      return ChangeOutcome.pending;
    }
    switch (field) {
      case 'full_name':
        _p['name'] = value['fullName'];
      case 'licence':
        _p['licence'] = {'number': value['number'], 'expiresOn': value['expiresOn']};
      case 'vehicle':
        _p['vehicle'] = {'type': value['type'], 'owner': value['owner'], 'registration': value['registration']};
    }
    return ChangeOutcome.applied;
  }

  String _summary(String field, Map<String, Object?> v) => switch (field) {
    'full_name' => '${v['fullName']}',
    'licence' => 'XXXX${_last4(v['number'])} · valid to ${v['expiresOn']}',
    'vehicle' => '${vehicleTypeLabels[v['type']] ?? v['type']} · ${v['registration'] ?? ''}',
    _ => v['kind'] == 'upi' ? 'XXXX@upi' : 'XXXX${_last4(v['accountNumber'])}',
  };

  @override
  Future<void> uploadDocument({
    required String type,
    String? number,
    String? expiresOn,
    required PickedDocument file,
  }) async {
    final err = checkPickedDocument(file);
    if (err != null) throw ApiException(400, err);
    _docs.removeWhere((d) => d['type'] == type);
    final days = expiresOn == null ? null : parseDay(expiresOn)!.difference(parseDay(_today)!).inDays;
    _docs.add(
      _doc(
        type,
        status: 'pending',
        number: number == null || number.isEmpty ? null : 'XXXX${_last4(number)}',
        expiresInDays: days,
      ),
    );
    if (_p['verification'] != 'verified') _p['verification'] = 'pending';
  }

  @override
  Future<DocumentContent> openDocument(String id) async =>
      DocumentContent(bytes: base64Decode(_placeholderPng), isPdf: false);

  @override
  Future<void> uploadAvatar(File photo) async {}

  @override
  Future<void> sendPhoneCode(String phone) async {}

  @override
  Future<void> updatePhone(String phone, String code) async {
    if (code != '123456') throw ApiException(400, 'otp_invalid');
    _p['phone'] = phone;
  }
}
