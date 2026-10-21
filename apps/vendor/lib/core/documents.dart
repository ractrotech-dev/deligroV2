import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../models/money.dart';
import '../models/order.dart';
import 'format.dart';

/// The Partner app's printable documents (requirements §5, §11): tax invoice
/// (A4), receipt (80 mm roll, for Bluetooth / thermal printers through the
/// Android print service), settlement statement and sales report. Built on the
/// phone from data the API already returned. Noto Sans is bundled because the
/// PDF standard fonts have no ₹.
class DocFonts {
  const DocFonts(this.regular, this.bold);

  final pw.Font regular;
  final pw.Font bold;

  static DocFonts? _cached;

  static Future<DocFonts> load() async => _cached ??= DocFonts(
    pw.Font.ttf(await rootBundle.load('assets/fonts/NotoSans-Regular.ttf')),
    pw.Font.ttf(await rootBundle.load('assets/fonts/NotoSans-Bold.ttf')),
  );

  pw.ThemeData get theme => pw.ThemeData.withFont(base: regular, bold: bold);
}

const _ink = PdfColor.fromInt(0xFF1F1A17);
const _muted = PdfColor.fromInt(0xFF6B635C);
const _line = PdfColor.fromInt(0xFFE4DDD5);
const _accent = PdfColor.fromInt(0xFFE8552D);

final _date = DateFormat('d MMM y, h:mm a', 'en_IN');
final _day = DateFormat('d MMM y', 'en_IN');

String _when(DateTime? d) => d == null ? '—' : _date.format(d);

String paymentLabel(String? method, String? status) {
  final m = method == 'online' ? 'Paid online' : 'Cash on delivery';
  if (method == 'online') return status == 'refunded' ? 'Online · refunded' : m;
  return status == 'paid' ? 'Cash · collected' : m;
}

/// GST on the order, split evenly into its central and state halves (intra-state supply).
({int cgst, int sgst}) splitGst(int tax) {
  final cgst = tax ~/ 2;
  return (cgst: cgst, sgst: tax - cgst);
}

/// The money rows every invoice and receipt prints, in order.
List<(String, int)> billRows(VendorOrder o) {
  final gst = splitGst(o.taxAmount);
  return [
    ('Item total', o.itemsSubtotal),
    if (o.discount > 0)
      (
        'Discount${o.couponCode == null ? '' : ' (${o.couponCode})'}${o.discountFundedBy == 'platform' ? ' · by Deligro' : ''}',
        -o.discount,
      ),
    if (o.deliveryFee > 0) ('Delivery fee', o.deliveryFee),
    if (o.taxAmount > 0) ...[('CGST', gst.cgst), ('SGST', gst.sgst)],
    if (o.tip > 0) ('Rider tip', o.tip),
  ];
}

pw.Widget _kv(String k, String v, {bool bold = false, double size = 10, PdfColor? color}) => pw.Padding(
  padding: const pw.EdgeInsets.symmetric(vertical: 1.5),
  child: pw.Row(
    children: [
      pw.Expanded(
        child: pw.Text(
          k,
          style: pw.TextStyle(fontSize: size, color: color ?? _ink, fontWeight: bold ? pw.FontWeight.bold : null),
        ),
      ),
      pw.Text(
        v,
        style: pw.TextStyle(fontSize: size, color: color ?? _ink, fontWeight: bold ? pw.FontWeight.bold : null),
      ),
    ],
  ),
);

pw.Widget _shopBlock(InvoiceProfile p, {double size = 9.5, bool center = false}) {
  final align = center ? pw.CrossAxisAlignment.center : pw.CrossAxisAlignment.start;
  final ta = center ? pw.TextAlign.center : pw.TextAlign.left;
  final s = pw.TextStyle(fontSize: size, color: _muted);
  return pw.Column(
    crossAxisAlignment: align,
    children: [
      pw.Text(
        p.name,
        textAlign: ta,
        style: pw.TextStyle(fontSize: size + 5, fontWeight: pw.FontWeight.bold, color: _ink),
      ),
      if (p.address != null) pw.Text(p.address!, textAlign: ta, style: s),
      if (p.phone != null) pw.Text('Phone ${p.phone}', textAlign: ta, style: s),
      if (p.gstin != null) pw.Text('GSTIN ${p.gstin}', textAlign: ta, style: s),
      if (p.fssai != null) pw.Text('FSSAI Lic. No. ${p.fssai}', textAlign: ta, style: s),
    ],
  );
}

/// A4 tax invoice. Titled "Tax invoice" only when the shop has a GSTIN on file.
Future<Uint8List> invoicePdf(VendorOrder o, InvoiceProfile shop, DocFonts f) async {
  final doc = pw.Document(theme: f.theme, title: 'Invoice ${o.invoiceNo ?? o.code}', author: shop.name);
  final title = shop.gstin != null ? 'TAX INVOICE' : 'INVOICE';
  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(36),
      footer: (ctx) => pw.Row(
        mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
        children: [
          pw.Text('Ordered on Deligro', style: const pw.TextStyle(fontSize: 8, color: _muted)),
          pw.Text('Page ${ctx.pageNumber} of ${ctx.pagesCount}', style: const pw.TextStyle(fontSize: 8, color: _muted)),
        ],
      ),
      build: (ctx) => [
        pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Expanded(child: _shopBlock(shop)),
            pw.Column(
              crossAxisAlignment: pw.CrossAxisAlignment.end,
              children: [
                pw.Text(
                  title,
                  style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold, color: _accent),
                ),
                pw.SizedBox(height: 6),
                pw.Text(
                  'Invoice no. ${o.invoiceNo ?? '—'}',
                  style: pw.TextStyle(fontSize: 10, fontWeight: pw.FontWeight.bold),
                ),
                pw.Text(
                  'Invoice date ${_when(o.invoiceAt ?? o.createdAt)}',
                  style: const pw.TextStyle(fontSize: 9, color: _muted),
                ),
                pw.Text(
                  'Order ${o.code} · ${_when(o.createdAt)}',
                  style: const pw.TextStyle(fontSize: 9, color: _muted),
                ),
              ],
            ),
          ],
        ),
        pw.SizedBox(height: 18),
        pw.Container(
          padding: const pw.EdgeInsets.all(10),
          decoration: pw.BoxDecoration(
            border: pw.Border.all(color: _line),
            borderRadius: pw.BorderRadius.circular(6),
          ),
          child: pw.Row(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            children: [
              pw.Expanded(
                child: pw.Column(
                  crossAxisAlignment: pw.CrossAxisAlignment.start,
                  children: [
                    pw.Text('BILLED TO', style: const pw.TextStyle(fontSize: 8, color: _muted)),
                    pw.Text(o.customerName, style: pw.TextStyle(fontSize: 10.5, fontWeight: pw.FontWeight.bold)),
                    if (o.deliveryLine != null)
                      pw.Text(o.deliveryLine!, style: const pw.TextStyle(fontSize: 9, color: _muted)),
                  ],
                ),
              ),
              pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.end,
                children: [
                  pw.Text('PAYMENT', style: const pw.TextStyle(fontSize: 8, color: _muted)),
                  pw.Text(
                    paymentLabel(o.paymentMethod, o.paymentStatus),
                    style: pw.TextStyle(fontSize: 10.5, fontWeight: pw.FontWeight.bold),
                  ),
                ],
              ),
            ],
          ),
        ),
        pw.SizedBox(height: 16),
        pw.TableHelper.fromTextArray(
          headers: ['#', 'Item', 'Qty', 'Rate', 'Amount'],
          data: [
            for (final (i, l) in o.lines.indexed)
              [
                '${i + 1}',
                l.addons.isEmpty ? l.name : '${l.name}\n+ ${l.addons.join(', ')}',
                '${l.qty}',
                rupees(l.price),
                rupees(l.amount),
              ],
          ],
          headerStyle: pw.TextStyle(fontSize: 9, fontWeight: pw.FontWeight.bold, color: _ink),
          cellStyle: const pw.TextStyle(fontSize: 9.5),
          headerDecoration: const pw.BoxDecoration(color: PdfColor.fromInt(0xFFF6F1EB)),
          border: const pw.TableBorder(
            horizontalInside: pw.BorderSide(color: _line, width: .5),
            bottom: pw.BorderSide(color: _line),
          ),
          columnWidths: {
            0: const pw.FixedColumnWidth(22),
            1: const pw.FlexColumnWidth(5),
            2: const pw.FixedColumnWidth(34),
            3: const pw.FixedColumnWidth(64),
            4: const pw.FixedColumnWidth(70),
          },
          headerAlignments: {
            0: pw.Alignment.centerLeft,
            1: pw.Alignment.centerLeft,
            2: pw.Alignment.center,
            3: pw.Alignment.centerRight,
            4: pw.Alignment.centerRight,
          },
          cellAlignments: {
            0: pw.Alignment.centerLeft,
            2: pw.Alignment.center,
            3: pw.Alignment.centerRight,
            4: pw.Alignment.centerRight,
          },
        ),
        pw.SizedBox(height: 10),
        pw.Row(
          children: [
            pw.Spacer(flex: 3),
            pw.Expanded(
              flex: 2,
              child: pw.Column(
                children: [
                  for (final (k, v) in billRows(o)) _kv(k, rupees(v)),
                  pw.Divider(color: _line),
                  _kv('Total', rupees(o.total), bold: true, size: 12),
                ],
              ),
            ),
          ],
        ),
        pw.SizedBox(height: 24),
        pw.Text(
          'GST is shown as charged on the order. This is a computer-generated invoice and needs no signature.',
          style: const pw.TextStyle(fontSize: 8, color: _muted),
        ),
      ],
    ),
  );
  return doc.save();
}

/// 80 mm thermal-roll receipt: the counter copy.
Future<Uint8List> receiptPdf(VendorOrder o, InvoiceProfile shop, DocFonts f) async {
  final doc = pw.Document(theme: f.theme, title: 'Receipt ${o.code}', author: shop.name);
  pw.Widget rule() => pw.Padding(
    padding: const pw.EdgeInsets.symmetric(vertical: 4),
    child: pw.Divider(color: PdfColors.grey600, borderStyle: pw.BorderStyle.dashed, thickness: .6, height: 1),
  );
  doc.addPage(
    pw.Page(
      pageFormat: PdfPageFormat.roll80.copyWith(marginLeft: 8, marginRight: 8, marginTop: 10, marginBottom: 14),
      build: (ctx) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: [
          _shopBlock(shop, size: 7.5, center: true),
          rule(),
          _kv('Order', o.code, size: 8, bold: true),
          if (o.invoiceNo != null) _kv('Invoice', o.invoiceNo!, size: 8),
          _kv('Placed', _when(o.createdAt), size: 8),
          _kv('Customer', o.customerName, size: 8),
          _kv('Payment', paymentLabel(o.paymentMethod, o.paymentStatus), size: 8),
          rule(),
          for (final l in o.lines) ...[
            pw.Row(
              crossAxisAlignment: pw.CrossAxisAlignment.start,
              children: [
                pw.SizedBox(
                  width: 18,
                  child: pw.Text('${l.qty}×', style: pw.TextStyle(fontSize: 8.5, fontWeight: pw.FontWeight.bold)),
                ),
                pw.Expanded(child: pw.Text(l.name, style: const pw.TextStyle(fontSize: 8.5))),
                pw.Text(rupees(l.amount), style: const pw.TextStyle(fontSize: 8.5)),
              ],
            ),
            if (l.addons.isNotEmpty)
              pw.Padding(
                padding: const pw.EdgeInsets.only(left: 18),
                child: pw.Text('+ ${l.addons.join(', ')}', style: const pw.TextStyle(fontSize: 7.5, color: _muted)),
              ),
          ],
          rule(),
          for (final (k, v) in billRows(o)) _kv(k, rupees(v), size: 8),
          rule(),
          _kv('TOTAL', rupees(o.total), size: 11, bold: true),
          pw.SizedBox(height: 8),
          pw.Text(
            'Thank you! Ordered on Deligro.',
            textAlign: pw.TextAlign.center,
            style: const pw.TextStyle(fontSize: 7.5, color: _muted),
          ),
        ],
      ),
    ),
  );
  return doc.save();
}

pw.Widget _header(String title, String subtitle, String shop) => pw.Column(
  crossAxisAlignment: pw.CrossAxisAlignment.start,
  children: [
    pw.Text(shop, style: const pw.TextStyle(fontSize: 10, color: _muted)),
    pw.Text(
      title,
      style: pw.TextStyle(fontSize: 17, fontWeight: pw.FontWeight.bold, color: _ink),
    ),
    pw.Text(subtitle, style: const pw.TextStyle(fontSize: 9.5, color: _muted)),
    pw.SizedBox(height: 12),
  ],
);

pw.Widget _table(List<String> headers, List<List<String>> rows, {Set<int> right = const {}}) =>
    pw.TableHelper.fromTextArray(
      headers: headers,
      data: rows,
      headerStyle: pw.TextStyle(fontSize: 8, fontWeight: pw.FontWeight.bold),
      cellStyle: const pw.TextStyle(fontSize: 8),
      headerDecoration: const pw.BoxDecoration(color: PdfColor.fromInt(0xFFF6F1EB)),
      border: const pw.TableBorder(horizontalInside: pw.BorderSide(color: _line, width: .5)),
      cellAlignments: {for (final i in right) i: pw.Alignment.centerRight},
      headerAlignments: {for (final i in right) i: pw.Alignment.centerRight},
    );

/// A settlement statement (A4).
Future<Uint8List> statementPdf(Statement s, DocFonts f) async {
  final doc = pw.Document(theme: f.theme, title: 'Settlement ${s.periodLabel}', author: s.shopName);
  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(32),
      build: (ctx) => [
        _header(
          'Settlement statement',
          '${s.periodLabel} · ${s.status == 'void' ? 'Voided' : 'Paid ${s.paidAt == null ? '' : _day.format(s.paidAt!)}'}'
              '${s.paymentRef == null ? '' : ' · Ref ${s.paymentRef}'}${s.paidTo == null ? '' : ' · ${s.paidTo}'}',
          s.shopName,
        ),
        pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Expanded(
              child: pw.Column(
                children: [
                  _kv('Food sales', rupees(s.foodGross)),
                  _kv(
                    'Commission (${s.commissionPct.toStringAsFixed(s.commissionPct % 1 == 0 ? 0 : 1)}%)',
                    rupees(-s.commission),
                  ),
                  _kv('GST on commission (${s.commissionGstPct.toStringAsFixed(0)}%)', rupees(-s.commissionGst)),
                  if (s.otherCharges > 0)
                    _kv('Other charges (${rupees(s.otherChargesPerOrder)}/order)', rupees(-s.otherCharges)),
                  if (s.refundsRecovered > 0) _kv('Refunds recovered', rupees(-s.refundsRecovered)),
                  pw.Divider(color: _line),
                  _kv('Net payable', rupees(s.netPayable), bold: true, size: 12),
                ],
              ),
            ),
            pw.SizedBox(width: 160),
          ],
        ),
        pw.SizedBox(height: 16),
        _table(
          ['Order', 'Delivered', 'Pay', 'Sale', 'Charges', 'Refund', 'Earnings', 'To payout'],
          [
            for (final l in s.lines)
              [
                l.code,
                l.deliveredAt == null ? '' : _day.format(l.deliveredAt!),
                l.paymentMethod == 'online' ? 'Online' : 'Cash',
                rupees(l.sale),
                rupees(l.charges),
                l.refundRecovered == 0 ? '' : rupees(l.refundRecovered),
                rupees(l.earnings),
                rupees(l.contribution),
              ],
          ],
          right: {3, 4, 5, 6, 7},
        ),
        pw.SizedBox(height: 10),
        pw.Text(
          'Cash orders: the shop already holds the money, so Deligro deducts its charges from the payout ("To payout" is negative).',
          style: const pw.TextStyle(fontSize: 7.5, color: _muted),
        ),
      ],
    ),
  );
  return doc.save();
}

/// The sales report (A4 landscape).
Future<Uint8List> reportPdf(SalesReport r, String filterLabel, DocFonts f) async {
  final doc = pw.Document(theme: f.theme, title: 'Sales report ${r.from} to ${r.to}', author: r.shop);
  final t = r.totals;
  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4.landscape,
      margin: const pw.EdgeInsets.all(28),
      build: (ctx) => [
        _header('Sales report', '${reportRangeLabel(r.from, r.to)} · $filterLabel', r.shop),
        pw.Wrap(
          spacing: 18,
          runSpacing: 6,
          children: [
            for (final (k, v) in [
              ('Orders', '${t.orders}'),
              ('Completed', '${t.completed}'),
              ('Cancelled', '${t.cancelled}'),
              ('Sales', rupees(t.sales)),
              ('Discounts', rupees(t.vendorDiscounts)),
              if (t.charges != null) ('Charges', rupees(t.charges!)),
              if (t.earnings != null) ('Earnings', rupees(t.earnings!)),
              if (t.settled != null) ('Settled', rupees(t.settled!)),
              if (t.unsettled != null) ('Unsettled', rupees(t.unsettled!)),
              ('Cash / online', '${t.codOrders} / ${t.onlineOrders}'),
            ])
              pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text(k, style: const pw.TextStyle(fontSize: 8, color: _muted)),
                  pw.Text(v, style: pw.TextStyle(fontSize: 11, fontWeight: pw.FontWeight.bold)),
                ],
              ),
          ],
        ),
        pw.SizedBox(height: 14),
        _table(
          [
            'Order',
            'Placed',
            'Status',
            'Payment',
            'Sale',
            'Discount',
            if (r.includesMoney) ...['Charges', 'Earnings', 'Settlement'],
          ],
          [
            for (final row in r.rows)
              reportCells(row, r.includesMoney).map((c) => c is int ? rupees(c) : '${c ?? ''}').toList(),
          ],
          right: r.includesMoney ? {4, 5, 6, 7} : {4, 5},
        ),
      ],
    ),
  );
  return doc.save();
}

/// "1 Oct – 21 Oct 2026".
String reportRangeLabel(String from, String to) {
  final a = DateTime.parse(from), b = DateTime.parse(to);
  if (from == to) return _day.format(a);
  final left = DateFormat(a.year == b.year ? 'd MMM' : 'd MMM y', 'en_IN').format(a);
  return '$left – ${_day.format(b)}';
}

String stageWord(String stage) => switch (stage) {
  'new' => 'New',
  'accepted' => 'Accepted',
  'preparing' => 'Preparing',
  'ready' => 'Ready',
  'completed' => 'Completed',
  'cancelled' => 'Cancelled',
  _ => stage,
};

/// One report row as cells: rupee amounts stay ints (formatted by the PDF,
/// numeric in CSV / Excel).
List<Object?> reportCells(ReportRow row, bool money) => [
  row.code,
  row.createdAt == null ? '' : DateFormat('yyyy-MM-dd HH:mm').format(row.createdAt!),
  stageWord(row.stage),
  row.paymentMethod == 'online' ? 'Online' : 'Cash',
  row.sale,
  row.vendorDiscount,
  if (money) ...[
    row.charges,
    row.earnings,
    row.settlement == null ? '' : (row.settlement == 'settled' ? 'Settled' : 'Unsettled'),
  ],
];
