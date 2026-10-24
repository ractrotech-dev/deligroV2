import 'package:deligro_partner/data/bulk_repository.dart';
import 'package:deligro_partner/features/products/bulk_upload_screen.dart';
import 'package:deligro_partner/models/bulk.dart';
import 'package:deligro_partner/state/menu.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

class MockBulkRepo extends Mock implements BulkRepository {}

Map<String, dynamic> _preview({int create = 1, int update = 2, int unchanged = 3, int error = 1}) => {
  'mode': 'preview',
  'counts': {'create': create, 'update': update, 'unchanged': unchanged, 'error': error},
  'items': [
    {'line': 2, 'action': 'update', 'name': 'Paneer Tikka', 'changes': ['price 220 → 249', 'stock 10 → 25']},
    {'line': 3, 'action': 'create', 'name': 'Gulab Jamun', 'changes': ['new dish at ₹80']},
    {'line': 5, 'action': 'error', 'name': 'Dal', 'changes': [], 'message': 'More than one dish has this name. Add the id or the category.'},
    {'line': 4, 'action': 'unchanged', 'name': 'Chicken Biryani', 'changes': []},
  ],
  'moreItems': 0,
  'issues': [
    {'line': 7, 'message': 'price "abc" is not a number'},
    {'line': 0, 'message': 'Only the first 500 rows are read; the rest are ignored.'},
  ],
  'columns': ['id', 'price', 'stock'],
  'unknownColumns': ['colour'],
  'ignoredColumns': [],
};

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  test('a preview answer is read into counts, items and plain issue lines', () {
    final o = BulkOutcome.fromJson(_preview());
    expect(o.applyMode, isFalse);
    expect((o.create, o.update, o.unchanged, o.error), (1, 2, 3, 1));
    expect(o.toApply, 3);
    expect(o.items.first.changes, ['price 220 → 249', 'stock 10 → 25']);
    expect(o.items[2].isError, isTrue);
    expect(o.issues, ['Row 7: price "abc" is not a number', 'Only the first 500 rows are read; the rest are ignored.']);
    expect(o.unknownColumns, ['colour']);
    expect(o.applied, isNull);
  });

  test('an apply answer carries what was saved', () {
    final o = BulkOutcome.fromJson({
      ..._preview(),
      'mode': 'apply',
      'applied': {'created': 1, 'updated': 2, 'failed': 1, 'errors': ['Row 5 (Dal): could not be saved.']},
    });
    expect(o.applyMode, isTrue);
    expect(o.applied!.created, 1);
    expect(o.applied!.errors.single, 'Row 5 (Dal): could not be saved.');
  });

  test('a thin answer does not crash the reader', () {
    final o = BulkOutcome.fromJson(const {});
    expect((o.create, o.update, o.error), (0, 0, 0));
    expect(o.items, isEmpty);
  });

  testPartner('the screen offers the three downloads and the upload', (t) async {
    final repo = MockBulkRepo();
    await pumpPartner(t, child: const BulkUploadScreen(), overrides: [bulkRepoProvider.overrideWithValue(repo)]);
    await t.pumpAndSettle();
    expect(find.text('Bulk upload'), findsOneWidget);
    expect(find.text('Your current menu (Excel)'), findsOneWidget);
    expect(find.text('Your current menu (CSV)'), findsOneWidget);
    expect(find.text('Blank template'), findsOneWidget);
    expect(find.text('Choose a file'), findsOneWidget);
    expect(find.textContaining('Apply'), findsNothing, reason: 'nothing to apply before a file is read');
  });
}
