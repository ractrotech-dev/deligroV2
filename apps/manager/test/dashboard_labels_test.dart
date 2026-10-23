// The dashboard shows the client document's eighteen figures (§1), in the
// document's order and words — not a close paraphrase.
import 'package:flutter_test/flutter_test.dart';
import 'package:deligro_manager/models/dashboard.dart';

const specLabels = [
  "Today's Total Sales",
  'Total Sales',
  "Today's Orders",
  'Total Orders',
  'Pending Orders',
  'Completed Orders',
  'Cancelled Orders',
  'Active Vendors',
  'Online Vendors',
  'Active Riders',
  'Online Riders',
  'Riders Currently on Delivery',
  'Total Delivery Fees',
  'Total Platform Commission',
  'Vendor Payments Due',
  'Rider Payments Due',
  'Pending Marketing Requests',
  'Pending Support Tickets',
];

void main() {
  test('the dashboard has the eighteen figures of the client document', () {
    expect(FigureKey.values.length, 18);
  });

  test('their labels are the document\'s words, in the document\'s order', () {
    expect(FigureKey.values.map((k) => k.en).toList(), specLabels);
  });
}
