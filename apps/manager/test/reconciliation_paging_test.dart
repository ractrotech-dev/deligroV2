import 'package:deligro_manager/models/finance.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _page(List<String> ids, String? next, {int missing = 9}) => {
      'section': 'online',
      'filters': {'from': '2026-10-01', 'to': '2026-10-21', 'zone': null},
      'summary': {'matched': 0, 'online_mismatch': 0, 'missing_payment': missing},
      'items': [
        for (final id in ids)
          {'orderId': id, 'orderCode': id.toUpperCase(), 'orderTotal': 100, 'paidAmount': null, 'paymentId': null, 'state': 'missing_payment'},
      ],
      'nextCursor': next,
    };

void main() {
  test('every page can be loaded: later pages append, the summary stays the whole count', () {
    final first = Reconciliation.fromJson(_page(['a', 'b'], 'c1'));
    final both = first.followedBy(Reconciliation.fromJson(_page(['c', 'd'], 'c2', missing: 0)));
    expect(both.onlineItems.map((i) => i.orderId), ['a', 'b', 'c', 'd']);
    expect(both.nextCursor, 'c2');
    expect(both.summary['missing_payment'], 9, reason: 'the summary counts every order, from the first answer');
  });

  test('a row already shown is not shown twice', () {
    final first = Reconciliation.fromJson(_page(['a', 'b'], 'c1'));
    final both = first.followedBy(Reconciliation.fromJson(_page(['b', 'c'], null)));
    expect(both.onlineItems.map((i) => i.orderId), ['a', 'b', 'c']);
    expect(both.nextCursor, isNull);
  });
}
