// Phase 6: Profile & documents. The models, the file and number checks, the
// repository's requests, the Profile / Documents / upload / viewer screens, the
// edit and payout-account sheets, and the More row and Home badge. No network:
// the repository is a fake (or an `ApiClient` over a `MockClient`), the file
// picker, camera and phone dialer are replaced.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/document_file.dart';
import 'package:deligro_rider/core/errors.dart';
import 'package:deligro_rider/core/image_shrink.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/data/fixtures/fixture_profile.dart';
import 'package:deligro_rider/data/profile_repository.dart';
import 'package:deligro_rider/features/more/more_screen.dart';
import 'package:deligro_rider/features/profile/document_upload_screen.dart';
import 'package:deligro_rider/features/profile/profile_widgets.dart';
import 'package:deligro_rider/models/profile.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/profile.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image/image.dart' as img;
import 'package:supabase_flutter/supabase_flutter.dart';

// 22 Oct 2026, 09:00 IST.
final _now = DateTime.utc(2026, 10, 22, 3, 30);

// A 1x1 PNG.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);
final _pdfHead = Uint8List.fromList([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
final _jpegHead = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]);
// An MP4's header ("....ftyp"): what a video renamed .pdf starts with.
final _videoHead = Uint8List.fromList([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);

Map<String, dynamic> _doc(
  String type, {
  String status = 'verified',
  String? masked,
  int? days,
  String? expiresOn,
  String? remarks,
}) => {
  'id': 'doc-$type',
  'type': type,
  'numberMasked': masked,
  'expiresOn': expiresOn ?? (days == null ? null : '2026-12-01'),
  'daysLeft': days,
  'status': status,
  'remarks': remarks,
  'uploadedAt': '2026-10-01T10:00:00.000Z',
};

Map<String, dynamic> _profileJson({
  String verification = 'pending',
  String? verificationNote,
  String? name = 'Ravi Kumar',
  Map<String, dynamic>? address,
  Map<String, dynamic>? vehicle,
  Map<String, dynamic>? licence,
  Map<String, dynamic>? emergency,
  Object? payout = const {'kind': 'bank', 'masked': 'XXXX4521'},
  List<Map<String, dynamic>>? documents,
  List<Map<String, dynamic>> pending = const [],
  bool needsAttention = false,
  String? avatarUrl,
}) => {
  'riderCode': 'DR-0042',
  'name': name,
  'phone': '+919876543210',
  'avatarUrl': avatarUrl,
  'address': address ?? {'line': '14 Shivaji Nagar', 'city': 'Pune', 'pincode': '411005'},
  'vehicle': vehicle ?? {'type': 'ev_bike', 'owner': 'deligro', 'registration': 'MH12EV4821'},
  'licence': licence ?? {'number': 'MH1220260001234', 'expiresOn': '2027-03-01'},
  'emergency': emergency ?? {'name': 'Sunita Kumar', 'phone': '+919822012345', 'relation': 'Wife'},
  'payoutAccount': payout,
  'verification': verification,
  'verificationNote': verificationNote,
  'documents': documents ?? [_doc('aadhaar', masked: 'XXXX-XXXX-4821'), _doc('driving_licence', masked: 'XXXX1234', days: 130), _doc('photo')],
  'pendingChanges': pending,
  'needsAttention': needsAttention,
};

class _Fake implements ProfileRepository {
  _Fake([Map<String, dynamic>? json]) : json = json ?? _profileJson();

  Map<String, dynamic> json;
  List<ChangeRequestView> requests = [];
  final calls = <String>[];
  final changes = <({String field, Map<String, Object?> value})>[];
  final direct = <({Map<String, Object?>? address, Map<String, Object?>? emergency})>[];
  final uploads = <({String type, String? number, String? expiresOn, String path})>[];
  final phoneCodes = <String>[];
  final phoneUpdates = <({String phone, String code})>[];
  ChangeOutcome outcome = ChangeOutcome.pending;
  Object? changeError;
  Object? uploadError;
  Object? profileError;
  Object? openError;
  Object? phoneError;
  DocumentContent content = DocumentContent(bytes: _png, isPdf: false);
  Completer<void>? holdUpload;
  int profileCalls = 0;

  @override
  Future<RiderProfile> profile() async {
    profileCalls++;
    final e = profileError;
    if (e != null) throw e;
    return RiderProfile.fromJson(json);
  }

  @override
  Future<List<ChangeRequestView>> changeRequests() async => requests;

  @override
  Future<void> saveDirect({Map<String, Object?>? address, Map<String, Object?>? emergency}) async {
    calls.add('saveDirect');
    direct.add((address: address, emergency: emergency));
  }

  @override
  Future<ChangeOutcome> requestChange(String field, Map<String, Object?> value) async {
    calls.add('requestChange');
    final e = changeError;
    if (e != null) throw e;
    changes.add((field: field, value: value));
    return outcome;
  }

  @override
  Future<void> uploadDocument({
    required String type,
    String? number,
    String? expiresOn,
    required PickedDocument file,
  }) async {
    calls.add('uploadDocument');
    await holdUpload?.future;
    final e = uploadError;
    if (e != null) throw e;
    uploads.add((type: type, number: number, expiresOn: expiresOn, path: file.path));
  }

  @override
  Future<DocumentContent> openDocument(String id) async {
    calls.add('openDocument:$id');
    final e = openError;
    if (e != null) throw e;
    return content;
  }

  @override
  Future<void> uploadAvatar(File photo) async => calls.add('uploadAvatar');

  @override
  Future<void> sendPhoneCode(String phone) async {
    calls.add('sendPhoneCode');
    phoneCodes.add(phone);
  }

  @override
  Future<void> updatePhone(String phone, String code) async {
    calls.add('updatePhone');
    final e = phoneError;
    if (e != null) throw e;
    phoneUpdates.add((phone: phone, code: code));
  }
}

RiderMe _me({Map<String, bool> features = const {}, ProfileStatus? profile}) => RiderMe(
  id: 'rider-1',
  name: 'Ravi Kumar',
  riderCode: 'DR-0042',
  availability: RiderAvailabilityDto.offline,
  phase: 'offline',
  features: features,
  profile: profile,
);

Future<void> _pump(
  WidgetTester tester, {
  required _Fake repo,
  String start = '/more/profile',
  RiderMe? me,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  double height = 1400,
  DocumentChooser? chooser,
  PdfRasterizer? rasterizer,
  DocumentShrinker? shrinker,
  AvatarChooser? avatarChooser,
  List<Uri>? opened,
}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(
    overrides: [
      profileRepoProvider.overrideWithValue(repo),
      clockProvider.overrideWithValue(() => _now),
      meProvider.overrideWith((_) async => me ?? _me()),
      urlOpenerProvider.overrideWithValue((uri) async {
        opened?.add(uri);
        return true;
      }),
      if (chooser != null) documentChooserProvider.overrideWithValue(chooser),
      if (rasterizer != null) pdfRasterizerProvider.overrideWithValue(rasterizer),
      if (shrinker != null) documentShrinkerProvider.overrideWithValue(shrinker),
      if (avatarChooser != null) avatarChooserProvider.overrideWithValue(avatarChooser),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: GoRouter(initialLocation: start, routes: [moreRoute]),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
}

Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  if (f.evaluate().isEmpty) {
    await tester.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);
  }
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final f = find.byKey(Key(key));
  await tester.ensureVisible(f);
  await tester.enterText(f, text);
  await tester.pump();
}

Finder _in(String key, Finder what) => find.descendant(of: find.byKey(Key(key)), matching: what);

TextStyle? _styleOf(WidgetTester tester, Finder f) => tester.widget<Text>(f).style;

bool _disabled(WidgetTester tester, String key) => tester.widget<TextButton>(find.byKey(Key(key))).onPressed == null;

PickedDocument _picked({
  String name = 'licence.jpg',
  int size = 200 * 1024,
  Uint8List? head,
  String path = '/nowhere/licence.jpg',
  bool temporary = false,
}) => PickedDocument(path: path, name: name, size: size, head: head ?? _jpegHead, temporary: temporary);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('models', () {
    test('a profile reads the server JSON, masked numbers as sent, any script intact', () {
      final p = RiderProfile.fromJson(
        _profileJson(
          name: 'Zoë Müller',
          address: {'line': '\u0968\u0969 \u0936\u093f\u0935\u093e\u091c\u0940 \u0928\u0917\u0930', 'city': 'Pune', 'pincode': '411005'},
          pending: [
            {'id': 'c1', 'field': 'payout_account', 'createdAt': '2026-10-21T10:00:00.000Z', 'summary': 'XXXX9921'},
          ],
        ),
      );
      expect(p.name, 'Zoë Müller');
      expect(p.address.line, '\u0968\u0969 \u0936\u093f\u0935\u093e\u091c\u0940 \u0928\u0917\u0930');
      expect(p.payoutAccount!.masked, 'XXXX4521');
      expect(p.payoutAccount!.kindLabel, 'Bank account');
      expect(p.pendingFor('payout_account')!.summary, 'XXXX9921');
      expect(p.pendingFor('full_name'), isNull);
      expect(p.verification, Verification.pending);
      expect(p.documents.map((d) => d.type), ['aadhaar', 'driving_licence', 'photo']);
    });

    test('missing and odd values do not throw', () {
      final p = RiderProfile.fromJson({'payoutAccount': 'nonsense', 'verification': 'weird', 'documents': [3, null]});
      expect(p.payoutAccount, isNull);
      expect(p.verification, Verification.unverified);
      expect(p.documents, isEmpty);
      expect(p.vehicle.owner, 'deligro');
    });

    test('/me carries the profile status; a server without it leaves it null', () {
      final withStatus = RiderMe.fromJson({
        'id': 'r',
        'profile': {'verification': 'verified', 'documentsComplete': true, 'needsAttention': false},
      });
      expect(withStatus.profile!.verification, Verification.verified);
      expect(withStatus.profile!.needsAttention, isFalse);
      expect(RiderMe.fromJson({'id': 'r'}).profile, isNull);
      expect(RiderMe.fromJson({'id': 'r', 'profile': null}).profile, isNull);
    });

    test('which documents are required follows the vehicle owner', () {
      expect(requiredDocTypesFor('deligro'), ['aadhaar', 'driving_licence', 'photo']);
      expect(requiredDocTypesFor('rider'), ['aadhaar', 'driving_licence', 'photo', 'vehicle_rc', 'insurance', 'puc']);
    });

    test('the documents check sorts missing, rejected, expired and waiting', () {
      RiderDocument d(String type, String status, {int? days}) =>
          RiderDocument.fromJson(_doc(type, status: status, days: days));
      final c = DocumentsCheck.of([
        d('aadhaar', 'verified'),
        d('driving_licence', 'verified', days: -2),
        d('photo', 'rejected'),
      ], 'deligro');
      expect(c.missing, isEmpty);
      expect(c.expired, ['driving_licence']);
      expect(c.rejected, ['photo']);
      expect(c.complete, isFalse);
      expect(c.riderToDo, isTrue);

      final waiting = DocumentsCheck.of([d('aadhaar', 'pending'), d('driving_licence', 'verified', days: 90), d('photo', 'verified')], 'deligro');
      expect(waiting.awaitingReview, ['aadhaar']);
      expect(waiting.riderToDo, isFalse);

      final own = DocumentsCheck.of([d('aadhaar', 'verified'), d('driving_licence', 'verified', days: 90), d('photo', 'verified')], 'rider');
      expect(own.missing, ['vehicle_rc', 'insurance', 'puc']);

      final all = DocumentsCheck.of([d('aadhaar', 'verified'), d('driving_licence', 'verified', days: 90), d('photo', 'verified')], 'deligro');
      expect(all.complete, isTrue);
    });

    test('a document past its last day, or marked expired, is expired', () {
      expect(RiderDocument.fromJson(_doc('puc', days: -1)).expired, isTrue);
      expect(RiderDocument.fromJson(_doc('puc', status: 'expired')).expired, isTrue);
      expect(RiderDocument.fromJson(_doc('puc', days: 0)).expired, isFalse);
      expect(RiderDocument.fromJson(_doc('puc', days: 12)).expiringSoon, isTrue);
      expect(RiderDocument.fromJson(_doc('puc', days: 31)).expiringSoon, isFalse);
    });
  });

  group('file checks', () {
    test('the type comes from the first bytes, never the name', () {
      expect(sniffDocumentMime(_pdfHead), 'application/pdf');
      expect(sniffDocumentMime(_jpegHead), 'image/jpeg');
      expect(sniffDocumentMime(_png), 'image/png');
      expect(sniffDocumentMime(_videoHead), isNull);
      expect(sniffDocumentMime(const []), isNull);
    });

    test('a video renamed .pdf is the wrong type; only an absurd file is too large; a big photo is shrunk, not refused', () {
      expect(checkPickedDocument(_picked(name: 'clip.pdf', size: 40 * 1024 * 1024, head: _videoHead)), 'bad_type');
      expect(checkPickedDocument(_picked(name: 'clip.pdf', size: 60 * 1024 * 1024, head: _videoHead)), 'too_large');
      expect(checkPickedDocument(_picked(name: 'clip.pdf', size: 3 * 1024 * 1024, head: _videoHead)), 'bad_type');
      expect(checkPickedDocument(_picked(size: 0)), 'bad_type');
      expect(checkPickedDocument(_picked(size: 25 * 1024 * 1024)), isNull, reason: 'a 25 MB gallery photo can be shrunk');
      expect(checkPickedDocument(_picked(size: pickedImageMaxBytes + 1)), 'too_large');
      expect(checkPickedDocument(_picked(name: 'a.pdf', head: _pdfHead)), isNull);
    });

    test('a PDF over 4 MB is refused with its own message; a PDF of 4 MB goes', () {
      expect(checkPickedDocument(_picked(name: 'a.pdf', size: documentUploadMaxBytes + 1, head: _pdfHead)), 'pdf_too_large');
      expect(checkPickedDocument(_picked(name: 'a.pdf', size: documentUploadMaxBytes, head: _pdfHead)), isNull);
      expect(checkPickedDocument(_picked(name: 'a.pdf', size: pickedImageMaxBytes + 1, head: _pdfHead)), 'too_large');
    });

    testWidgets('a big photo is shrunk to a JPEG of at most 4 MB, in memory; nothing to shrink returns the same file', (tester) async {
      // Noise does not compress: a 1500 x 1500 PNG of it is several MB.
      final noise = img.Image(width: 1500, height: 1500);
      var v = 12345;
      for (final p in noise) {
        v = (v * 1103515245 + 12345) & 0x7fffffff;
        p.setRgb(v & 255, (v >> 8) & 255, (v >> 16) & 255);
      }
      final png = Uint8List.fromList(img.encodePng(noise, level: 1));
      expect(png.length, greaterThan(documentUploadMaxBytes));
      final dir = Directory.systemTemp.createTempSync('p6shrink');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/big.png')..writeAsBytesSync(png);

      await tester.runAsync(() async {
        final jpeg = await shrinkToJpeg(png);
        expect(jpeg, isNotNull);
        expect(jpeg!.length, lessThanOrEqualTo(documentUploadMaxBytes));
        expect(sniffDocumentMime(jpeg), 'image/jpeg');
        expect(await shrinkToJpeg(Uint8List.fromList([1, 2, 3])), isNull, reason: 'not an image at all');

        final before = dir.listSync().length;
        final shrunk = await shrinkPickedDocument(
          PickedDocument(path: file.path, name: 'big.png', size: png.length, head: Uint8List.fromList(png.sublist(0, 16))),
        );
        expect(shrunk.bytes, isNotNull, reason: 'held in memory');
        expect(shrunk.path, isEmpty, reason: 'no file was written');
        expect(shrunk.mime, 'image/jpeg');
        expect(shrunk.name, 'big.jpg');
        expect(shrunk.size, shrunk.bytes!.length);
        expect(shrunk.size, lessThanOrEqualTo(documentUploadMaxBytes));
        expect(dir.listSync().length, before, reason: 'nothing new on disk');

        final small = _picked(size: 100 * 1024);
        expect(identical(await shrinkPickedDocument(small), small), isTrue);
        final pdf = _picked(name: 'a.pdf', size: 3 * 1024 * 1024, head: _pdfHead);
        expect(identical(await shrinkPickedDocument(pdf), pdf), isTrue);
      });
    });

    test('numbers are checked per document type', () {
      final aadhaar = docTypeOf('aadhaar')!;
      expect(numberProblem(aadhaar, '1234 5678 9012'), isNull);
      expect(numberProblem(aadhaar, '1234-5678-9012'), isNull);
      expect(numberProblem(aadhaar, '1234 5678 901'), isNotNull);
      expect(numberProblem(aadhaar, ''), isNotNull);
      expect(tidyNumber('aadhaar', '1234-5678 9012'), '123456789012');
      expect(numberProblem(docTypeOf('pan')!, 'abcde1234f'), isNull);
      expect(numberProblem(docTypeOf('pan')!, 'ABCDE12345'), isNotNull);
      expect(numberProblem(docTypeOf('driving_licence')!, 'MH12 2026 0001234'), isNull);
      expect(numberProblem(docTypeOf('driving_licence')!, 'MH12'), isNotNull);
      expect(numberProblem(docTypeOf('insurance')!, ''), isNull, reason: 'optional when empty');
      expect(numberProblem(docTypeOf('photo')!, 'anything'), isNull);
    });
  });

  group('repository requests', () {
    late List<http.BaseRequest> seen;
    late Map<String, ({int status, Object body})> routes;
    late SupabaseClient supabase;
    late ApiProfileRepository repo;

    setUp(() {
      seen = [];
      routes = {};
      supabase = SupabaseClient('http://localhost:1', 'k', authOptions: const AuthClientOptions(autoRefreshToken: false));
      addTearDown(() => unawaited(supabase.dispose()));
      final client = MockClient((req) async {
        seen.add(req);
        final r = routes['${req.method} ${req.url.path}'];
        if (r == null) return http.Response('{"error":"not_found"}', 404);
        return http.Response(jsonEncode(r.body), r.status, headers: {'content-type': 'application/json'});
      });
      final download = MockClient((req) async {
        seen.add(req);
        return http.Response.bytes(_pdfHead, 200);
      });
      repo = ApiProfileRepository(ApiClient(supabase.auth, client: client), downloader: download);
    });

    test('profile reads {profile}', () async {
      routes['GET /api/rider/profile'] = (status: 200, body: {'profile': _profileJson()});
      final p = await repo.profile();
      expect(p.riderCode, 'DR-0042');
      expect(p.payoutAccount!.masked, 'XXXX4521');
    });

    test('a malformed answer is a bad_response, not a crash', () async {
      routes['GET /api/rider/profile'] = (status: 200, body: {'profile': 'x'});
      await expectLater(repo.profile(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_response')));
    });

    test('change requests list reads the server rows', () async {
      routes['GET /api/rider/profile/change-requests'] = (
        status: 200,
        body: {
          'changeRequests': [
            {'id': 'c1', 'field': 'vehicle', 'status': 'rejected', 'createdAt': '2026-10-01T00:00:00Z', 'decidedAt': '2026-10-02T00:00:00Z', 'decisionNote': 'No', 'summary': 'EV bike'},
          ],
        },
      );
      final list = await repo.changeRequests();
      expect(list.single.decisionNote, 'No');
      expect(list.single.status, 'rejected');
    });

    test('saveDirect sends only what was given; requestChange sends {field, value} and reads the status', () async {
      routes['PATCH /api/rider/profile'] = (status: 200, body: {'ok': true});
      routes['POST /api/rider/profile/change-requests'] = (status: 201, body: {'ok': true, 'id': 'x', 'status': 'applied'});
      await repo.saveDirect(address: {'line': 'A', 'city': null});
      expect(jsonDecode((seen.single as http.Request).body), {
        'address': {'line': 'A', 'city': null},
      });
      seen.clear();
      final outcome = await repo.requestChange('full_name', {'fullName': 'Ravi'});
      expect(outcome, ChangeOutcome.applied);
      expect(jsonDecode((seen.single as http.Request).body), {
        'field': 'full_name',
        'value': {'fullName': 'Ravi'},
      });
      routes['POST /api/rider/profile/change-requests'] = (status: 201, body: {'ok': true, 'id': 'x', 'status': 'pending'});
      expect(await repo.requestChange('payout_account', {'kind': 'upi', 'upiId': 'a@b'}), ChangeOutcome.pending);
    });

    test('a duplicate request and a bad value come back as the server codes', () async {
      routes['POST /api/rider/profile/change-requests'] = (status: 409, body: {'error': 'duplicate_pending'});
      await expectLater(repo.requestChange('vehicle', {}), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'duplicate_pending')));
      routes['POST /api/rider/profile/change-requests'] = (status: 400, body: {'error': 'invalid_value', 'field': 'ifsc'});
      await expectLater(repo.requestChange('payout_account', {}), throwsA(isA<ApiException>().having((e) => e.body['field'], 'field', 'ifsc')));
    });

    test('an upload is multipart with the type, number, expiry and the file typed by its bytes', () async {
      routes['POST /api/rider/documents'] = (status: 201, body: {'ok': true, 'id': 'd'});
      final dir = Directory.systemTemp.createTempSync('p6doc');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/scan.bin')..writeAsBytesSync([..._jpegHead, 1, 2, 3]);
      await repo.uploadDocument(
        type: 'driving_licence',
        number: 'MH1220260001234',
        expiresOn: '2027-03-01',
        file: PickedDocument(path: file.path, name: 'scan.bin', size: 9, head: _jpegHead),
      );
      final req = seen.single as http.Request;
      expect(req.url.path, '/api/rider/documents');
      expect(req.headers['content-type'], startsWith('multipart/form-data'));
      // The server answers 411 without a length: it must know the size before reading.
      expect(req.contentLength, req.bodyBytes.length);
      expect(req.contentLength, greaterThan(0));
      final body = latin1.decode(req.bodyBytes);
      expect(body, contains('name="type"'));
      expect(body, contains('driving_licence'));
      expect(body, contains('MH1220260001234'));
      expect(body, contains('name="expiresOn"'));
      expect(body, contains('2027-03-01'));
      expect(body, contains('name="file"'));
      expect(body.toLowerCase(), contains('content-type: image/jpeg'));
    });

    test('a PDF goes up as application/pdf, never octet-stream', () async {
      routes['POST /api/rider/documents'] = (status: 201, body: {'ok': true, 'id': 'd'});
      final dir = Directory.systemTemp.createTempSync('p6pdf');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/doc')..writeAsBytesSync([..._pdfHead, 1, 2, 3]);
      await repo.uploadDocument(
        type: 'aadhaar',
        number: '123456789012',
        file: PickedDocument(path: file.path, name: 'doc', size: 11, head: _pdfHead),
      );
      final body = latin1.decode((seen.single as http.Request).bodyBytes).toLowerCase();
      expect(body, contains('content-type: application/pdf'));
      expect(body, isNot(contains('octet-stream')));
    });

    test('an upload of something that is not a PDF/JPEG/PNG never leaves the phone', () async {
      await expectLater(
        repo.uploadDocument(type: 'photo', file: _picked(name: 'clip.pdf', head: _videoHead)),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_type')),
      );
      expect(seen, isEmpty);
    });

    test('opening a document asks for the signed link, then fetches it with no session cookie', () async {
      routes['GET /api/rider/documents/doc-1/url'] = (status: 200, body: {'url': 'https://files.example/signed?token=abc', 'expiresIn': 600});
      final content = await repo.openDocument('doc-1');
      expect(content.isPdf, isTrue);
      expect(seen.length, 2);
      expect(seen[1].url.host, 'files.example');
      expect(seen[1].headers.containsKey('cookie'), isFalse);
      expect(seen[1].headers.containsKey('authorization'), isFalse);
    });

    test('a document that is not this rider\'s is a plain 404', () async {
      routes['GET /api/rider/documents/other/url'] = (status: 404, body: {'error': 'not_found'});
      await expectLater(repo.openDocument('other'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
      expect(seen.length, 1);
    });

    test('the phone change sends the code to the new number, then phone + phoneOtp', () async {
      routes['POST /api/auth/otp/request'] = (status: 200, body: {'ok': true});
      routes['PATCH /api/profile'] = (status: 200, body: {'ok': true});
      await repo.sendPhoneCode('+919000000001');
      await repo.updatePhone('+919000000001', '123456');
      expect(jsonDecode((seen[0] as http.Request).body), {'phone': '+919000000001'});
      expect(jsonDecode((seen[1] as http.Request).body), {'phone': '+919000000001', 'phoneOtp': '123456'});
    });
  });

  group('Profile screen', () {
    testWidgets('shows the rider ID, the licence in full and the account only masked', (tester) async {
      await _pump(tester, repo: _Fake());
      expect(find.text('DR-0042'), findsWidgets);
      expect(_in('info-rider-id', find.text('DR-0042')), findsOneWidget);
      expect(_in('info-licence', find.text('MH1220260001234')), findsOneWidget);
      expect(_in('info-payout', find.text('XXXX4521')), findsOneWidget);
      expect(_in('info-payout', find.text('Bank account')), findsOneWidget);
      expect(find.textContaining('4521', findRichText: true), findsOneWidget);
    });

    testWidgets('names and addresses in any script show intact and go back unchanged', (tester) async {
      const name = 'Zoë Müller';
      const line = '\u0968\u0969 \u0936\u093f\u0935\u093e\u091c\u0940 \u0928\u0917\u0930';
      final repo = _Fake(_profileJson(name: name, address: {'line': line, 'city': 'Pune', 'pincode': '411005'}));
      await _pump(tester, repo: repo);
      expect(_in('info-name', find.text(name)), findsOneWidget);
      expect(find.byKey(const Key('profile-name')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('profile-name'))).data, name);
      expect(_in('info-address', find.textContaining(line)), findsOneWidget);

      // The name sheet starts from the stored name and sends it as typed.
      await _tap(tester, find.byKey(const Key('edit-name')));
      expect(tester.widget<TextField>(find.byKey(const Key('field-name'))).controller!.text, name);
      await _type(tester, 'field-name', '\u0930\u0935\u093f \u0915\u0941\u092e\u093e\u0930');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.changes.single.field, 'full_name');
      expect(repo.changes.single.value, {'fullName': '\u0930\u0935\u093f \u0915\u0941\u092e\u093e\u0930'});

      // The address sheet keeps the Devanagari line as stored.
      await _tap(tester, find.byKey(const Key('edit-address')));
      expect(tester.widget<TextField>(find.byKey(const Key('field-line'))).controller!.text, line);
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.direct.single.address!['line'], line);
    });

    testWidgets('the verification card says what is wrong in plain words', (tester) async {
      final repo = _Fake(
        _profileJson(
          documents: [
            _doc('driving_licence', status: 'expired', masked: 'XXXX1234', days: -3),
            _doc('photo', status: 'rejected', remarks: 'Too blurry'),
          ],
          needsAttention: true,
        ),
      );
      await _pump(tester, repo: repo);
      expect(_in('verification-card', find.text('Waiting for Deligro')), findsOneWidget);
      expect(_in('verification-card', find.text('Upload your Aadhaar.')), findsOneWidget);
      expect(_in('verification-card', find.text('Driving licence has expired. Upload a new one.')), findsOneWidget);
      expect(_in('verification-card', find.textContaining('Photo was rejected: Too blurry')), findsOneWidget);
    });

    testWidgets('a verified rider with everything in order sees no to-do', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(verification: 'verified')));
      expect(_in('verification-card', find.text('You are verified')), findsOneWidget);
      expect(find.byKey(const Key('open-documents')), findsNothing);
      expect(find.byKey(const Key('documents-dot')), findsNothing);
    });

    testWidgets('an open request shows "Waiting for Deligro" and switches that Edit off', (tester) async {
      final repo = _Fake(
        _profileJson(
          pending: [
            {'id': 'c1', 'field': 'full_name', 'createdAt': '2026-10-21T10:00:00Z', 'summary': 'Ravi Kumar Yadav'},
            {'id': 'c2', 'field': 'payout_account', 'createdAt': '2026-10-21T10:00:00Z', 'summary': 'XXXX9921'},
          ],
        ),
      );
      await _pump(tester, repo: repo);
      expect(_in('pending-name', find.text('Waiting for Deligro')), findsOneWidget);
      expect(_in('pending-name', find.text('Asked for: Ravi Kumar Yadav')), findsOneWidget);
      expect(_in('pending-payout', find.text('Asked for: XXXX9921')), findsOneWidget);
      expect(_disabled(tester, 'edit-name'), isTrue);
      expect(_disabled(tester, 'edit-payout'), isTrue);
      // Tapping a switched-off button opens nothing and sends nothing.
      await tester.tap(find.byKey(const Key('edit-name')), warnIfMissed: false);
      await _settle(tester);
      expect(find.byKey(const Key('sheet-submit')), findsNothing);
      expect(repo.calls, isEmpty);
      // Fields with no request open stay editable.
      expect(_disabled(tester, 'edit-vehicle'), isFalse);
    });

    testWidgets('earlier answers from Deligro are listed, with the reason', (tester) async {
      final repo = _Fake()
        ..requests = [
          ChangeRequestView.fromJson({'id': 'a', 'field': 'vehicle', 'status': 'rejected', 'decisionNote': 'Registration does not match'}),
          ChangeRequestView.fromJson({'id': 'b', 'field': 'full_name', 'status': 'approved'}),
          ChangeRequestView.fromJson({'id': 'c', 'field': 'licence', 'status': 'pending'}),
        ];
      await _pump(tester, repo: repo);
      await tester.scrollUntilVisible(find.byKey(const Key('decisions')), 300);
      expect(_in('decisions', find.text('Vehicle change declined: Registration does not match')), findsOneWidget);
      expect(_in('decisions', find.text('Name change approved.')), findsOneWidget);
      expect(find.textContaining('Driving licence change'), findsNothing);
    });

    testWidgets('driver.profile_edit off: everything is read-only and says so', (tester) async {
      await _pump(tester, repo: _Fake(), me: _me(features: {'driver.profile_edit': false}));
      expect(find.byKey(const Key('editing-off')), findsOneWidget);
      for (final k in ['edit-name', 'edit-phone', 'edit-address', 'edit-vehicle', 'edit-licence', 'edit-emergency', 'edit-payout']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      expect(find.byKey(const Key('avatar-camera')), findsNothing);
    });

    testWidgets('the emergency contact has a Call button that dials the number', (tester) async {
      final seen = <Uri>[];
      await _pump(tester, repo: _Fake(), opened: seen);
      expect(_in('info-emergency', find.text('Sunita Kumar')), findsOneWidget);
      expect(_in('info-emergency', find.text('Wife')), findsOneWidget, reason: 'the relation is the label');
      await _tap(tester, find.byKey(const Key('call-emergency')));
      expect(seen.single.toString(), 'tel:+919822012345');
    });

    testWidgets('a rider with no emergency contact sees "Not added yet" and no Call button', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(emergency: {'name': null, 'phone': null, 'relation': null})));
      expect(_in('info-emergency', find.text('Not added yet')), findsOneWidget);
      expect(find.byKey(const Key('call-emergency')), findsNothing);
    });

    testWidgets('a load failure offers Try again', (tester) async {
      final repo = _Fake()..profileError = ApiException(503, 'migration_pending');
      await _pump(tester, repo: repo);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.text('This is not available yet. Please try again later.'), findsOneWidget);
    });

    testWidgets('an expired licence date is shown in the deal colour', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(licence: {'number': 'MH1220260001234', 'expiresOn': '2020-01-01'})));
      final note = _in('info-licence', find.byKey(const Key('note-licence')));
      expect(_styleOf(tester, note)?.color, AppColors.light.deal);
    });
  });

  group('edit sheets', () {
    testWidgets('the address saves directly, blank fields clear, and says Address saved', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-address')));
      await _type(tester, 'field-line', '');
      await _type(tester, 'field-pincode', '411001');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.direct.single.address, {'line': null, 'city': 'Pune', 'pincode': '411001'});
      expect(repo.changes, isEmpty, reason: 'an address is not a change request');
      expect(find.text('Address saved.'), findsOneWidget);
    });

    testWidgets('a pincode with 5 digits is refused on the phone', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-address')));
      await _type(tester, 'field-pincode', '41100');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('A pincode has 6 digits.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('a verified rider\'s name goes as a request: "Send for approval", then waits', (tester) async {
      final repo = _Fake(_profileJson(verification: 'verified'));
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-name')));
      expect(find.text('Send for approval'), findsOneWidget);
      expect(find.textContaining('Deligro has to approve'), findsOneWidget);
      await _type(tester, 'field-name', 'Ravi Kumar Yadav');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.changes.single.field, 'full_name');
      expect(repo.changes.single.value, {'fullName': 'Ravi Kumar Yadav'});
      expect(find.text('Name change sent. Waiting for Deligro.'), findsOneWidget);
    });

    testWidgets('an unverified rider\'s change is applied at once, and the app says so', (tester) async {
      final repo = _Fake(_profileJson(verification: 'unverified'))..outcome = ChangeOutcome.applied;
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-name')));
      expect(find.text('Save'), findsOneWidget);
      await _type(tester, 'field-name', 'Ravi K');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Name saved.'), findsOneWidget);
    });

    testWidgets('a too-short name and a name with digits are refused, nothing sent', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-name')));
      await _type(tester, 'field-name', 'R');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Enter at least 2 letters.'), findsOneWidget);
      await _type(tester, 'field-name', 'Ravi 2');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.textContaining('Use letters'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('the server\'s duplicate_pending shows in the sheet and keeps it open', (tester) async {
      final repo = _Fake()..changeError = ApiException(409, 'duplicate_pending');
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-vehicle')));
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('You already have a change waiting for Deligro.'), findsOneWidget);
      expect(find.byKey(const Key('sheet-submit')), findsOneWidget);
    });

    testWidgets('a server invalid_value lands under the field it names', (tester) async {
      final repo = _Fake()..changeError = ApiException(400, 'invalid_value', body: {'field': 'registration'});
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-vehicle')));
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Check what you entered and try again.'), findsOneWidget);
    });

    testWidgets('the vehicle request carries type, owner and a tidy registration', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-vehicle')));
      await _tap(tester, find.byKey(const Key('type-scooter')));
      await _tap(tester, find.byKey(const Key('owner-rider')));
      await _type(tester, 'field-registration', 'mh 12 ab 1234');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.changes.single.field, 'vehicle');
      expect(repo.changes.single.value, {'type': 'scooter', 'owner': 'rider', 'registration': 'MH12AB1234'});
    });

    testWidgets('the licence request needs a real number and a date that has not passed', (tester) async {
      final repo = _Fake(_profileJson(licence: {'number': 'MH1220260001234', 'expiresOn': '2020-01-01'}));
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-licence')));
      expect(find.text('Choose a date that has not passed.'), findsNothing);
      await _type(tester, 'field-number', 'AB');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.textContaining('Use letters, numbers'), findsOneWidget);
      expect(find.text('Choose a date that has not passed.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('the emergency contact saves directly and validates the phone', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-emergency')));
      await _type(tester, 'field-phone', '12345');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Enter a phone number with 10 to 13 digits.'), findsOneWidget);
      await _type(tester, 'field-phone', '98220 12345');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.direct.single.emergency, {'name': 'Sunita Kumar', 'relation': 'Wife', 'phone': '9822012345'});
      expect(repo.changes, isEmpty);
    });

    testWidgets('the phone change sends a code to the NEW number, then the code with it', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-phone')));
      await _type(tester, 'field-phone', '12345');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Enter a valid 10-digit Indian mobile number.'), findsOneWidget);
      expect(repo.calls, isEmpty);
      await _type(tester, 'field-phone', '9000000001');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.phoneCodes, ['+919000000001']);
      expect(find.text('We sent a code to +91 9000000001.'), findsOneWidget);
      await _type(tester, 'field-code', '123');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.phoneUpdates, isEmpty, reason: 'a short code is not sent');
      await _type(tester, 'field-code', '123456');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.phoneUpdates.single, (phone: '+919000000001', code: '123456'));
      expect(find.text('Phone number changed.'), findsOneWidget);
    });

    testWidgets('a wrong code is explained and the sheet stays', (tester) async {
      final repo = _Fake()..phoneError = ApiException(400, 'otp_invalid');
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-phone')));
      await _type(tester, 'field-phone', '9000000001');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      await _type(tester, 'field-code', '000000');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('That code is not right.'), findsOneWidget);
      expect(find.byKey(const Key('field-code')), findsOneWidget);
    });
  });

  group('payout account sheet', () {
    testWidgets('shows the account on file masked and takes the new number hidden', (tester) async {
      await _pump(tester, repo: _Fake());
      await _tap(tester, find.byKey(const Key('edit-payout')));
      expect(find.text('On file: Bank account XXXX4521'), findsOneWidget);
      for (final k in ['field-accountNumber', 'field-confirmAccountNumber']) {
        final f = tester.widget<TextField>(find.byKey(Key(k)));
        expect(f.obscureText, isTrue, reason: k);
        expect(f.enableSuggestions, isFalse, reason: k);
        expect(f.autocorrect, isFalse, reason: k);
      }
      // Show reveals only on request.
      await _tap(tester, find.byKey(const Key('show-accountNumber')));
      expect(tester.widget<TextField>(find.byKey(const Key('field-accountNumber'))).obscureText, isFalse);
    });

    testWidgets('the two account numbers must match and the IFSC must be valid, before anything is sent', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-payout')));
      await _type(tester, 'field-holderName', 'Ravi Kumar');
      await _type(tester, 'field-accountNumber', '123456789012');
      await _type(tester, 'field-confirmAccountNumber', '123456789013');
      await _type(tester, 'field-ifsc', 'HDFC123');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('The two numbers do not match.'), findsOneWidget);
      expect(find.text('Enter an IFSC like HDFC0001234.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('a good bank account goes as a request and then waits for Deligro', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-payout')));
      await _type(tester, 'field-holderName', 'Ravi Kumar');
      await _type(tester, 'field-accountNumber', '1234 5678 9012');
      await _type(tester, 'field-confirmAccountNumber', '123456789012');
      await _type(tester, 'field-ifsc', 'hdfc0001234');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.changes.single.field, 'payout_account');
      expect(repo.changes.single.value, {
        'kind': 'bank',
        'holderName': 'Ravi Kumar',
        'accountNumber': '123456789012',
        'confirmAccountNumber': '123456789012',
        'ifsc': 'HDFC0001234',
      });
      expect(repo.direct, isEmpty);
      expect(find.text('Payout account change sent. Waiting for Deligro.'), findsOneWidget);
      // Nothing on screen shows the number just typed.
      expect(find.textContaining('123456789012'), findsNothing);
    });

    testWidgets('a UPI id is validated and sent as a request', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-payout')));
      await _tap(tester, find.byKey(const Key('kind-upi')));
      expect(find.byKey(const Key('field-accountNumber')), findsNothing);
      await _type(tester, 'field-upiId', 'ravi');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('Enter a UPI ID like name@okbank.'), findsOneWidget);
      await _type(tester, 'field-upiId', 'Ravi.K@okbank');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(repo.changes.single.value, {'kind': 'upi', 'upiId': 'ravi.k@okbank'});
    });

    testWidgets('a second request while one waits is refused by the server and said so', (tester) async {
      final repo = _Fake()..changeError = ApiException(409, 'duplicate_pending');
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('edit-payout')));
      await _tap(tester, find.byKey(const Key('kind-upi')));
      await _type(tester, 'field-upiId', 'ravi@okbank');
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      expect(find.text('You already have a change waiting for Deligro.'), findsOneWidget);
    });

    testWidgets('a rider with no account sees "Add"', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(payout: null)));
      expect(_in('info-payout', find.text('Not added yet')), findsOneWidget);
      expect(tester.widget<TextButton>(find.byKey(const Key('edit-payout'))).child, isA<Text>().having((t) => t.data, 'label', 'Add'));
      await _tap(tester, find.byKey(const Key('edit-payout')));
      expect(find.text('Add your payout account'), findsOneWidget);
    });
  });

  group('Documents screen', () {
    testWidgets('lists the required documents with status chips, masked numbers and expiry', (tester) async {
      final repo = _Fake(
        _profileJson(
          documents: [
            _doc('aadhaar', masked: 'XXXX-XXXX-4821'),
            _doc('driving_licence', masked: 'XXXX1234', days: 12, status: 'pending'),
            _doc('photo', status: 'rejected', remarks: 'Too blurry'),
            _doc('pan', masked: 'XXXX1234', days: null),
          ],
        ),
      );
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      expect(_in('status-aadhaar', find.text('Verified')), findsOneWidget);
      expect(_in('doc-aadhaar', find.text('XXXX-XXXX-4821')), findsOneWidget);
      expect(_in('status-driving_licence', find.text('Waiting for Deligro')), findsOneWidget);
      expect(_in('doc-driving_licence', find.text('Expires in 12 days')), findsOneWidget);
      expect(_in('status-photo', find.text('Rejected')), findsOneWidget);
      expect(_in('doc-photo', find.text('Too blurry')), findsOneWidget);
      expect(find.text('NEEDED TO GET VERIFIED'), findsOneWidget);
      expect(find.text('OPTIONAL'), findsOneWidget);
      expect(find.byKey(const Key('doc-pan')), findsOneWidget);
      // RC, insurance and PUC only matter on the rider's own vehicle.
      expect(find.byKey(const Key('doc-vehicle_rc')), findsNothing);
    });

    testWidgets('an expired document is red', (tester) async {
      final repo = _Fake(_profileJson(documents: [_doc('driving_licence', status: 'verified', masked: 'XXXX1234', days: -3)]));
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      expect(_in('status-driving_licence', find.text('Expired')), findsOneWidget);
      final line = find.byKey(const Key('expiry-driving_licence'));
      expect(tester.widget<Text>(line).data, 'Expired 3 days ago');
      expect(_styleOf(tester, line)?.color, AppColors.light.deal);
      final box = tester.widget<Container>(find.byKey(const Key('doc-driving_licence'))).decoration as BoxDecoration;
      expect((box.border as Border).top.color, AppColors.light.deal);
      // An expired document is offered "Upload again", not "Replace".
      expect(_in('upload-driving_licence', find.text('Upload again')), findsOneWidget);
    });

    testWidgets('a document that runs out soon is amber; a far one is quiet', (tester) async {
      final repo = _Fake(
        _profileJson(documents: [_doc('driving_licence', masked: 'XXXX1234', days: 7), _doc('aadhaar', masked: 'XXXX-XXXX-4821')]),
      );
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      final line = find.byKey(const Key('expiry-driving_licence'));
      expect(tester.widget<Text>(line).data, 'Expires in 7 days');
      expect(_styleOf(tester, line)?.color, AppColors.light.accentInk);
    });

    testWidgets('a missing document says so and offers Upload; an uploaded one offers View and Replace', (tester) async {
      final repo = _Fake(_profileJson(documents: [_doc('aadhaar', masked: 'XXXX-XXXX-4821')]));
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      expect(_in('status-photo', find.text('Not uploaded')), findsOneWidget);
      expect(_in('upload-photo', find.text('Upload')), findsOneWidget);
      expect(find.byKey(const Key('view-photo')), findsNothing);
      expect(find.byKey(const Key('view-aadhaar')), findsOneWidget);
      expect(_in('upload-aadhaar', find.text('Replace')), findsOneWidget);
    });

    testWidgets('on their own vehicle the rider is asked for RC, insurance and PUC too', (tester) async {
      final repo = _Fake(_profileJson(vehicle: {'type': 'bike', 'owner': 'rider', 'registration': 'MH12AB1234'}));
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 3000);
      for (final t in ['vehicle_rc', 'insurance', 'puc']) {
        expect(find.byKey(Key('doc-$t')), findsOneWidget, reason: t);
      }
    });

    testWidgets('editing off: documents can be viewed but not uploaded', (tester) async {
      await _pump(tester, repo: _Fake(), start: '/more/profile/documents', height: 2200, me: _me(features: {'driver.profile_edit': false}));
      expect(find.byKey(const Key('view-aadhaar')), findsOneWidget);
      expect(find.byKey(const Key('upload-aadhaar')), findsNothing);
    });

    testWidgets('View opens the document through the repository (signed link) and shows it', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      await _tap(tester, find.byKey(const Key('view-aadhaar')));
      expect(repo.calls, contains('openDocument:doc-aadhaar'));
      expect(find.byKey(const Key('document-viewer')), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('Aadhaar'), findsWidgets);
    });

    testWidgets('a PDF is drawn page by page and never written to disk by the app', (tester) async {
      final repo = _Fake()..content = DocumentContent(bytes: _pdfHead, isPdf: true);
      final rasterised = <int>[];
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents',
        height: 2200,
        rasterizer: (pdf) async {
          rasterised.add(pdf.length);
          return [_png, _png];
        },
      );
      await _tap(tester, find.byKey(const Key('view-aadhaar')));
      expect(rasterised, [_pdfHead.length]);
      expect(find.text('Page 1 of 2'), findsOneWidget);
    });

    testWidgets('a PDF with more than 8 pages says only the first 8 are shown', (tester) async {
      final repo = _Fake()..content = DocumentContent(bytes: _pdfHead, isPdf: true);
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents',
        height: 2200,
        rasterizer: (pdf) async => List.filled(pdfPagesShown + 1, _png),
      );
      await _tap(tester, find.byKey(const Key('view-aadhaar')));
      expect(find.text('Page 1 of 8 · Showing the first 8 pages'), findsOneWidget);
    });

    testWidgets('a link that fails shows Try again, not a blank page', (tester) async {
      final repo = _Fake()..openError = ApiException(404, 'not_found');
      await _pump(tester, repo: repo, start: '/more/profile/documents', height: 2200);
      await _tap(tester, find.byKey(const Key('view-aadhaar')));
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('Upload screen', () {
    DocumentChooser pick(PickedDocument? doc) => (source) async => doc;

    Future<_Fake> open(
      WidgetTester tester,
      String type, {
      PickedDocument? doc,
      Map<String, dynamic>? json,
    }) async {
      final repo = _Fake(json);
      await _pump(tester, repo: repo, start: '/more/profile/documents/upload/$type', chooser: pick(doc), height: 1600);
      return repo;
    }

    testWidgets('a 40 MB video renamed .pdf is refused before anything is sent', (tester) async {
      final repo = await open(tester, 'photo', doc: _picked(name: 'holiday.pdf', size: 40 * 1024 * 1024, head: _videoHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.byKey(const Key('error-file')), findsOneWidget);
      expect(find.text('Use a PDF, JPEG or PNG file.'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.calls, isEmpty);
    });

    testWidgets('an absurd file (60 MB) is too large', (tester) async {
      final repo = await open(tester, 'photo', doc: _picked(name: 'holiday.pdf', size: 60 * 1024 * 1024, head: _videoHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.text('That file is bigger than 4 MB.'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.calls, isEmpty);
    });

    testWidgets('a small video renamed .pdf is the wrong type', (tester) async {
      final repo = await open(tester, 'photo', doc: _picked(name: 'clip.pdf', size: 2 * 1024 * 1024, head: _videoHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.text('Use a PDF, JPEG or PNG file.'), findsOneWidget);
      expect(find.text('Unknown type', findRichText: true), findsNothing);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.calls, isEmpty);
    });

    testWidgets('removing a bad file lets the rider pick another', (tester) async {
      await open(tester, 'photo', doc: _picked(name: 'clip.pdf', size: 2 * 1024 * 1024, head: _videoHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      await _tap(tester, find.byKey(const Key('remove-file')));
      expect(find.byKey(const Key('error-file')), findsNothing);
      expect(find.byKey(const Key('pick-camera')), findsOneWidget);
    });

    testWidgets('a 5 MB PDF is refused on the phone with a clear message', (tester) async {
      final repo = await open(tester, 'aadhaar', doc: _picked(name: 'scan.pdf', size: 5 * 1024 * 1024, head: _pdfHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.textContaining('That PDF is bigger than 4 MB'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.calls, isEmpty);
    });

    testWidgets('a 7 MB photo is shrunk first and the shrunk copy is what is sent', (tester) async {
      final shrunk = <String>[];
      final repo = _Fake();
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents/upload/photo',
        height: 1600,
        chooser: (source) async => _picked(name: 'big.png', size: 7 * 1024 * 1024, head: Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), path: '/nowhere/big.png'),
        shrinker: (f) async {
          shrunk.add(f.path);
          return PickedDocument(path: '/nowhere/big.jpg', name: 'big.jpg', size: 2 * 1024 * 1024, head: _jpegHead);
        },
      );
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.byKey(const Key('error-file')), findsNothing);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(shrunk, ['/nowhere/big.png']);
      expect(repo.uploads.single.path, '/nowhere/big.jpg');
    });

    testWidgets('a photo that cannot be made small enough says so and sends nothing', (tester) async {
      final repo = _Fake();
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents/upload/photo',
        height: 1600,
        chooser: (source) async => _picked(name: 'big.jpg', size: 7 * 1024 * 1024),
        shrinker: (f) async => throw const UnshrinkableException(),
      );
      await _tap(tester, find.byKey(const Key('pick-file')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.text("We couldn't make this photo small enough. Take a new photo."), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('nothing chosen: the upload asks for a file first', (tester) async {
      final repo = await open(tester, 'photo');
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.text('Choose a photo or a file first.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('a licence upload needs its number and expiry date', (tester) async {
      final repo = await open(tester, 'driving_licence', doc: _picked());
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.text('Enter the driving licence number.'), findsOneWidget);
      expect(find.text('Add the expiry date.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('an Aadhaar number must be 12 digits and is hidden while typed', (tester) async {
      final repo = await open(tester, 'aadhaar', doc: _picked(name: 'aadhaar.pdf', head: _pdfHead));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(tester.widget<TextField>(find.byKey(const Key('field-number'))).obscureText, isTrue);
      await _type(tester, 'field-number', '1234 5678 901');
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.text('An Aadhaar number has 12 digits.'), findsOneWidget);
      expect(repo.calls, isEmpty);
    });

    testWidgets('a good Aadhaar upload sends the tidy number and says it is waiting for Deligro', (tester) async {
      final repo = await open(tester, 'aadhaar', doc: _picked(name: 'aadhaar.pdf', head: _pdfHead, path: '/nowhere/aadhaar.pdf'));
      await _tap(tester, find.byKey(const Key('pick-file')));
      expect(find.text('aadhaar.pdf'), findsOneWidget);
      expect(find.textContaining('PDF'), findsWidgets);
      await _type(tester, 'field-number', '1234 5678 9012');
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.uploads.single, (type: 'aadhaar', number: '123456789012', expiresOn: null, path: '/nowhere/aadhaar.pdf'));
      expect(find.text('Aadhaar sent. Waiting for Deligro.'), findsOneWidget);
      expect(find.byKey(const Key('upload-submit')), findsNothing, reason: 'the screen closed');
    });

    testWidgets('a photo needs no number or date', (tester) async {
      final repo = await open(tester, 'photo', doc: _picked(name: 'me.jpg'));
      expect(find.byKey(const Key('field-number')), findsNothing);
      expect(find.byKey(const Key('field-expiry')), findsNothing);
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.uploads.single.type, 'photo');
      expect(repo.uploads.single.number, isNull);
    });

    testWidgets('the server\'s bad_type / invalid_number / expiry answers land on their fields', (tester) async {
      final repo = await open(tester, 'pan', doc: _picked(name: 'pan.jpg'));
      repo.uploadError = ApiException(400, 'invalid_number');
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _type(tester, 'field-number', 'ABCDE1234F');
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.text('Check the document number.'), findsOneWidget);
      repo.uploadError = ApiException(429, 'rate_limited');
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(find.byKey(const Key('upload-error')), findsOneWidget);
      expect(find.text('Too many tries. Please wait a moment.'), findsOneWidget);
    });

    testWidgets('while it is sending the button is off, so it cannot be sent twice', (tester) async {
      final repo = await open(tester, 'photo', doc: _picked(name: 'me.jpg'));
      repo.holdUpload = Completer<void>();
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(tester.widget<FilledButton>(find.byKey(const Key('upload-submit'))).onPressed, isNull);
      expect(repo.calls, ['uploadDocument']);
      repo.holdUpload!.complete();
      await _settle(tester);
      expect(repo.uploads, hasLength(1));
    });

    testWidgets('replacing a document says it will be checked again', (tester) async {
      await open(tester, 'aadhaar');
      expect(find.byKey(const Key('replace-note')), findsOneWidget);
      expect(find.text('Replace'), findsOneWidget);
    });

    testWidgets('the picked copy is deleted once it is sent', (tester) async {
      final dir = Directory.systemTemp.createTempSync('p6up');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/shot.jpg')..writeAsBytesSync([..._jpegHead, 9]);
      final repo = await open(tester, 'photo', doc: _picked(name: 'shot.jpg', path: file.path, temporary: true));
      await _tap(tester, find.byKey(const Key('pick-camera')));
      expect(file.existsSync(), isTrue);
      await _tap(tester, find.byKey(const Key('upload-submit')));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect(repo.uploads, hasLength(1));
      expect(file.existsSync(), isFalse);
    });

    testWidgets('a file the rider owns (not a copy) is never deleted', (tester) async {
      final dir = Directory.systemTemp.createTempSync('p6own');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/mine.jpg')..writeAsBytesSync([..._jpegHead, 9]);
      await open(tester, 'photo', doc: _picked(name: 'mine.jpg', path: file.path));
      await _tap(tester, find.byKey(const Key('pick-file')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect(file.existsSync(), isTrue);
    });

    testWidgets('an unknown document type does not crash', (tester) async {
      await open(tester, 'passport');
      expect(find.text('We could not find that document type'), findsOneWidget);
    });
  });

  group('More row and Home badge', () {
    Future<void> pumpMore(WidgetTester tester, RiderMe me) async {
      await _pump(tester, repo: _Fake(), start: '/more', me: me);
    }

    testWidgets('the Profile & documents row has a red dot when something needs attention', (tester) async {
      await pumpMore(tester, _me(profile: const ProfileStatus(verification: Verification.pending, needsAttention: true)));
      expect(find.text('Profile & documents'), findsOneWidget);
      expect(find.byKey(const Key('profile-dot')), findsOneWidget);
    });

    testWidgets('no dot when nothing needs the rider, nor on a server without the status', (tester) async {
      await pumpMore(tester, _me(profile: const ProfileStatus(verification: Verification.verified)));
      expect(find.byKey(const Key('profile-dot')), findsNothing);
      await pumpMore(tester, _me());
      expect(find.byKey(const Key('profile-dot')), findsNothing);
      expect(find.byKey(const Key('row-profile')), findsOneWidget);
    });

    testWidgets('tapping the row opens the profile', (tester) async {
      await pumpMore(tester, _me());
      await _tap(tester, find.byKey(const Key('row-profile')));
      expect(find.byKey(const Key('verification-card')), findsOneWidget);
    });

    testWidgets('the verification badge reads each state', (tester) async {
      Future<void> show(Verification v) async {
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: VerificationBadge(v))));
      }

      for (final (v, text) in [
        (Verification.verified, 'Verified'),
        (Verification.pending, 'Waiting for Deligro'),
        (Verification.rejected, 'Needs attention'),
        (Verification.unverified, 'Not verified'),
      ]) {
        await show(v);
        expect(find.text(text), findsOneWidget);
      }
    });
  });

  group('review fixes', () {
    testWidgets("I1: a rejected rider with every document verified sees Deligro's note, and no items-below text", (tester) async {
      final repo = _Fake(
        _profileJson(
          verification: 'rejected',
          verificationNote: 'The licence photo does not match the number you gave.',
          documents: [_doc('aadhaar', masked: 'XXXX-XXXX-4821'), _doc('driving_licence', masked: 'XXXX1234', days: 130), _doc('photo')],
        ),
      );
      await _pump(tester, repo: repo);
      expect(_in('verification-card', find.text('Deligro needs more from you')), findsOneWidget);
      expect(_in('verification-note', find.text('The licence photo does not match the number you gave.')), findsOneWidget);
      expect(_in('verification-note', find.text('Deligro says')), findsOneWidget);
      expect(_in('verification-card', find.text('Deligro could not verify you.')), findsOneWidget);
      expect(find.textContaining('items below'), findsNothing);
      expect(find.byKey(const Key('open-documents')), findsNothing);
    });

    testWidgets('I1: with something to fix, the card leads with the fix and still shows the note', (tester) async {
      final repo = _Fake(
        _profileJson(
          verification: 'rejected',
          verificationNote: 'Upload a sharper licence.',
          documents: [_doc('driving_licence', status: 'rejected', masked: 'XXXX1234', days: 130, remarks: 'Blurry')],
        ),
      );
      await _pump(tester, repo: repo);
      expect(_in('verification-note', find.text('Upload a sharper licence.')), findsOneWidget);
      expect(_in('verification-card', find.text('Fix the items below and send them again.')), findsOneWidget);
      expect(find.byKey(const Key('open-documents')), findsOneWidget);
    });

    testWidgets('I1: the note shows whenever it is there, even for a verified rider', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(verification: 'verified', verificationNote: 'Checked in person on 12 Oct.')));
      expect(_in('verification-note', find.text('Checked in person on 12 Oct.')), findsOneWidget);
    });

    testWidgets('M6: waiting for Deligro with things to fix says fix first, not "Deligro is checking"', (tester) async {
      final repo = _Fake(_profileJson(documents: [_doc('aadhaar', masked: 'XXXX-XXXX-4821')]));
      await _pump(tester, repo: repo);
      expect(_in('verification-card', find.text('Fix the items below first, so Deligro can finish checking.')), findsOneWidget);
      expect(find.text('Deligro is checking what you sent.'), findsNothing);
    });

    test('I1: the model reads verificationNote; empty is none', () {
      expect(RiderProfile.fromJson(_profileJson(verificationNote: 'Sharper photo')).verificationNote, 'Sharper photo');
      expect(RiderProfile.fromJson(_profileJson(verificationNote: '')).verificationNote, isNull);
      expect(RiderProfile.fromJson(_profileJson()).verificationNote, isNull);
    });

    test('I2: documents_expired reads as a plain sentence that points to Profile & documents', () {
      const text = 'Your documents have expired. Upload new ones in Profile & documents to take jobs.';
      expect(ApiException(409, 'documents_expired').friendly, text);
      expect(friendlyError('documents_expired'), text);
    });

    testWidgets('I3a: pressing back while it sends still refreshes the lists, and the sent copy is deleted', (tester) async {
      final dir = Directory.systemTemp.createTempSync('p6back');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/shot.jpg')..writeAsBytesSync([..._jpegHead, 9]);
      final repo = _Fake()..holdUpload = Completer<void>();
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents/upload/photo',
        height: 1600,
        chooser: (source) async => _picked(name: 'shot.jpg', path: file.path, temporary: true),
      );
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      expect(repo.calls, ['uploadDocument']);
      // The rider backs out while it is still sending.
      await tester.pageBack();
      await _settle(tester);
      expect(find.byKey(const Key('upload-submit')), findsNothing);
      expect(file.existsSync(), isTrue, reason: 'still being sent: not deleted from under the upload');
      final before = repo.profileCalls;
      repo.holdUpload!.complete();
      await _settle(tester);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await _settle(tester);
      expect(repo.uploads, hasLength(1));
      expect(repo.profileCalls, greaterThan(before), reason: 'the Documents page read the profile again');
      expect(file.existsSync(), isFalse, reason: 'deleted once sent');
    });

    testWidgets('I3a: a new profile photo uploads and refreshes even when the page was left meanwhile', (tester) async {
      final dir = Directory.systemTemp.createTempSync('p6avatar');
      addTearDown(() => dir.deleteSync(recursive: true));
      final photo = File('${dir.path}/me.jpg')..writeAsBytesSync([..._jpegHead, 1]);
      final gate = Completer<File?>();
      final repo = _Fake();
      await _pump(tester, repo: repo, avatarChooser: ({required bool camera}) => gate.future);
      await _tap(tester, find.byKey(const Key('avatar-edit')));
      await _tap(tester, find.byKey(const Key('avatar-camera')));
      // Still in the camera: the rider leaves the page.
      await tester.pageBack();
      await _settle(tester);
      expect(find.byKey(const Key('avatar-edit')), findsNothing);
      final before = repo.profileCalls;
      gate.complete(photo);
      await _settle(tester);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await _settle(tester);
      expect(repo.calls, contains('uploadAvatar'));
      expect(tester.takeException(), isNull);
      expect(repo.profileCalls, greaterThanOrEqualTo(before));
    });

    testWidgets('I3b: any other failure stops the spinner, says so, and keeps the file for a retry', (tester) async {
      final dir = Directory.systemTemp.createTempSync('p6fail');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/shot.jpg')..writeAsBytesSync([..._jpegHead, 9]);
      final repo = _Fake()..uploadError = StateError('boom');
      await _pump(
        tester,
        repo: repo,
        start: '/more/profile/documents/upload/photo',
        height: 1600,
        chooser: (source) async => _picked(name: 'shot.jpg', path: file.path, temporary: true),
      );
      await _tap(tester, find.byKey(const Key('pick-camera')));
      await _tap(tester, find.byKey(const Key('upload-submit')));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await _settle(tester);
      expect(find.text('Something went wrong. Please try again.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('upload-submit'))).onPressed, isNotNull);
      expect(file.existsSync(), isTrue, reason: 'kept, so the rider can try again');
      repo.uploadError = null;
      await _tap(tester, find.byKey(const Key('upload-submit')));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      expect(repo.uploads, hasLength(1));
      expect(file.existsSync(), isFalse);
    });

    test('M1: a shrunk photo is sent from memory as image/jpeg, with a name, and no file is read', () async {
      final seen = <http.BaseRequest>[];
      final supabase = SupabaseClient('http://localhost:1', 'k', authOptions: const AuthClientOptions(autoRefreshToken: false));
      addTearDown(() => unawaited(supabase.dispose()));
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response('{"ok":true,"id":"d"}', 201, headers: {'content-type': 'application/json'});
      });
      final repo = ApiProfileRepository(ApiClient(supabase.auth, client: client));
      final jpeg = Uint8List.fromList([..._jpegHead, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      await repo.uploadDocument(
        type: 'photo',
        file: PickedDocument(path: '', name: 'me.jpg', size: jpeg.length, head: jpeg, bytes: jpeg),
      );
      final req = seen.single as http.Request;
      expect(req.url.path, '/api/rider/documents');
      final body = latin1.decode(req.bodyBytes);
      expect(body, contains('filename="me.jpg"'));
      expect(body.toLowerCase(), contains('content-type: image/jpeg'));
      expect(body, contains(latin1.decode([1, 2, 3, 4, 5, 6, 7, 8, 9])));
      expect(req.contentLength, req.bodyBytes.length);
    });

    for (final (verification, label) in [
      ('unverified', 'Save'),
      ('pending', 'Send for approval'),
      ('rejected', 'Send for approval'),
      ('verified', 'Send for approval'),
    ]) {
      testWidgets('M4: a $verification rider name button reads "$label"', (tester) async {
        await _pump(tester, repo: _Fake(_profileJson(verification: verification)));
        await _tap(tester, find.byKey(const Key('edit-name')));
        expect(find.descendant(of: find.byKey(const Key('sheet-submit')), matching: find.text(label)), findsOneWidget);
      });
    }

    test('M4: everVerified is anything but unverified (the profile JSON has no verifiedAt)', () {
      expect(RiderProfile.fromJson(_profileJson(verification: 'pending')).everVerified, isTrue);
      expect(RiderProfile.fromJson(_profileJson(verification: 'rejected')).everVerified, isTrue);
      expect(RiderProfile.fromJson(_profileJson(verification: 'verified')).everVerified, isTrue);
      expect(RiderProfile.fromJson(_profileJson(verification: 'unverified')).everVerified, isFalse);
    });

    testWidgets('M5: a duplicate_pending answer re-reads the profile so the row shows the open request', (tester) async {
      final repo = _Fake()..changeError = ApiException(409, 'duplicate_pending');
      await _pump(tester, repo: repo);
      final before = repo.profileCalls;
      await _tap(tester, find.byKey(const Key('edit-vehicle')));
      await _tap(tester, find.byKey(const Key('sheet-submit')));
      await _settle(tester);
      expect(find.text('You already have a change waiting for Deligro.'), findsOneWidget);
      expect(repo.profileCalls, greaterThan(before));
    });

    testWidgets('M7: the Documents row dot follows the same rule as More: expiring within 30 days counts', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(documents: [_doc('aadhaar', masked: 'XXXX-XXXX-4821'), _doc('driving_licence', masked: 'XXXX1234', days: 12), _doc('photo')])));
      await tester.scrollUntilVisible(find.byKey(const Key('row-documents')), 300);
      expect(find.byKey(const Key('documents-dot')), findsOneWidget);
    });

    testWidgets('M7: no dot when every document is in date and verified', (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(documents: [_doc('aadhaar', masked: 'XXXX-XXXX-4821'), _doc('driving_licence', masked: 'XXXX1234', days: 130), _doc('photo')])));
      await tester.scrollUntilVisible(find.byKey(const Key('row-documents')), 300);
      expect(find.byKey(const Key('documents-dot')), findsNothing);
    });

    testWidgets("M9: a licence dated the day before the app's clock (22 Oct 2026) is shown as expired", (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(licence: {'number': 'MH1220260001234', 'expiresOn': '2026-10-21'})));
      expect(_styleOf(tester, _in('info-licence', find.byKey(const Key('note-licence'))))?.color, AppColors.light.deal);
    });

    testWidgets("M9: a licence valid through the app's today is not", (tester) async {
      await _pump(tester, repo: _Fake(_profileJson(licence: {'number': 'MH1220260001234', 'expiresOn': '2026-10-22'})));
      expect(_styleOf(tester, _in('info-licence', find.byKey(const Key('note-licence'))))?.color, isNot(AppColors.light.deal));
    });
  });

  group('look', () {
    for (final (name, brightness, scale) in [
      ('light', Brightness.light, 1.0),
      ('dark', Brightness.dark, 1.0),
      ('light at 1.3x', Brightness.light, 1.3),
      ('dark at 1.3x', Brightness.dark, 1.3),
    ]) {
      testWidgets('Profile, Documents and the payout sheet lay out in $name', (tester) async {
        final repo = _Fake(
          _profileJson(
            name: 'Zoë Müller-Krishnamurthy Venkataraghavan',
            documents: [
              _doc('driving_licence', status: 'expired', masked: 'XXXX1234', days: -3),
              _doc('photo', status: 'rejected', remarks: 'The photo is blurry. Take it again in good light.'),
            ],
            pending: [
              {'id': 'c1', 'field': 'payout_account', 'createdAt': '2026-10-21T10:00:00Z', 'summary': 'XXXX9921'},
            ],
          ),
        );
        await _pump(tester, repo: repo, brightness: brightness, textScale: scale, height: 900);
        expect(tester.takeException(), isNull);
        await tester.drag(find.byType(ListView).first, const Offset(0, -3000));
        await _settle(tester);
        expect(tester.takeException(), isNull);
        await _tap(tester, find.byKey(const Key('row-documents')));
        expect(tester.takeException(), isNull);
        expect(find.byKey(const Key('doc-driving_licence')), findsOneWidget);
      });

      testWidgets('the edit sheets and the upload screen fit in $name', (tester) async {
        final repo = _Fake();
        await _pump(tester, repo: repo, brightness: brightness, textScale: scale, height: 780);
        await _tap(tester, find.byKey(const Key('edit-payout')));
        expect(tester.takeException(), isNull);
        await _tap(tester, find.byKey(const Key('sheet-cancel')));
        await _tap(tester, find.byKey(const Key('edit-vehicle')));
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('fixtures', () {
    test('the fixture backend refuses to exist in a release build', () {
      expect(() => FixtureProfileRepository.create(releaseMode: true), throwsStateError);
    });

    test('mixed: documents in every state and two requests waiting', () async {
      final repo = FixtureProfileRepository.create(scenario: 'mixed', now: _now);
      final p = await repo.profile();
      expect(p.documents.map((d) => d.status), containsAll(['verified', 'expired', 'rejected', 'pending']));
      expect(p.pendingFor('full_name'), isNotNull);
      expect(p.pendingFor('licence'), isNotNull);
      expect(p.pendingFor('payout_account'), isNull, reason: 'the payout sheet can be tried on the mixed rider');
      expect(p.licence.number, fixtureProfileMarker);
      expect(await repo.changeRequests(), hasLength(3));
    });

    test('a second request for the same field is refused, as the server does', () async {
      final repo = FixtureProfileRepository.create(scenario: 'mixed', now: _now);
      await repo.requestChange('payout_account', {'kind': 'upi', 'upiId': 'a@b'});
      expect((await repo.profile()).pendingFor('payout_account')!.summary, 'XXXX@upi');
      await expectLater(
        repo.requestChange('payout_account', {'kind': 'upi', 'upiId': 'c@d'}),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'duplicate_pending')),
      );
    });

    test('a verified rider\'s licence change waits; an unverified rider\'s is applied', () async {
      final verified = FixtureProfileRepository.create(scenario: 'verified', now: _now);
      expect(await verified.requestChange('licence', {'number': 'MH1220260009999', 'expiresOn': '2028-01-01'}), ChangeOutcome.pending);
      final fresh = FixtureProfileRepository.create(scenario: 'new', now: _now);
      expect(await fresh.requestChange('full_name', {'fullName': 'Ravi'}), ChangeOutcome.applied);
      expect((await fresh.profile()).name, 'Ravi');
    });

    test('an upload replaces the old document and sends the rider back to pending', () async {
      final repo = FixtureProfileRepository.create(scenario: 'new', now: _now);
      await repo.uploadDocument(type: 'aadhaar', number: '123456789012', file: _picked(head: _pdfHead));
      final p = await repo.profile();
      expect(p.documentOf('aadhaar')!.numberMasked, 'XXXX9012');
      expect(p.verification, Verification.pending);
      await expectLater(
        repo.uploadDocument(type: 'photo', file: _picked(head: _videoHead)),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_type')),
      );
    });
  });
}
