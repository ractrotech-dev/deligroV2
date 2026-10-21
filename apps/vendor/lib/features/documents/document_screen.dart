import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

/// What to show in [DocumentScreen]: a title, the file name it shares as,
/// and how to build the PDF.
class DocumentRequest {
  const DocumentRequest({required this.title, required this.fileName, required this.build});

  final String title;
  final String fileName;
  final Future<Uint8List> Function() build;
}

/// A PDF on screen, with Print (the Android print service — Wi-Fi, PDF, and
/// Bluetooth / thermal printers through their print plugins) and Share.
class DocumentScreen extends StatelessWidget {
  const DocumentScreen({super.key, required this.request});

  final DocumentRequest request;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(request.title)),
    body: PdfPreview(
      build: (_) => request.build(),
      pdfFileName: request.fileName,
      canChangePageFormat: false,
      canChangeOrientation: false,
      canDebug: false,
      allowPrinting: true,
      allowSharing: true,
      loadingWidget: const Center(child: CircularProgressIndicator()),
      onError: (context, error) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text('This document couldn\'t be made. $error', textAlign: TextAlign.center),
        ),
      ),
    ),
  );
}
