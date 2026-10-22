import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/profile.dart';
import '../../state/profile.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// What the viewer shows: one picture, or a PDF's pages as pictures.
typedef ViewerPages = List<Uint8List>;

/// Fetches the document through its 10-minute signed link and returns what to
/// draw. The bytes live in memory only: nothing is written to the phone, so
/// there is no temporary copy to delete. A PDF is drawn page by page by the
/// printing plugin.
final documentPagesProvider = FutureProvider.autoDispose.family<ViewerPages, String>(
  retry: (_, _) => null,
  (ref, id) async {
    final DocumentContent content = await ref.watch(profileRepoProvider).openDocument(id);
    final bytes = Uint8List.fromList(content.bytes);
    if (!content.isPdf) return [bytes];
    final pages = await ref.read(pdfRasterizerProvider)(bytes);
    if (pages.isEmpty) throw const FormatException('empty pdf');
    return pages;
  },
);

class DocumentViewerScreen extends ConsumerWidget {
  const DocumentViewerScreen({super.key, required this.id, required this.title});

  final String id;
  final String title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pages = ref.watch(documentPagesProvider(id));
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        bottom: false,
        child: AsyncBody<ViewerPages>(
          value: pages,
          onRetry: () => ref.invalidate(documentPagesProvider(id)),
          builder: (list) => _Pages(pages: list),
        ),
      ),
    );
  }
}

/// The pages side by side (swipe), each one pinch-zoomable.
class _Pages extends StatefulWidget {
  const _Pages({required this.pages});

  final ViewerPages pages;

  @override
  State<_Pages> createState() => _PagesState();
}

class _PagesState extends State<_Pages> {
  int _page = 0;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        Expanded(
          child: PageView.builder(
            key: const Key('document-viewer'),
            itemCount: widget.pages.length,
            onPageChanged: (i) => setState(() => _page = i),
            itemBuilder: (_, i) => InteractiveViewer(
              minScale: 1,
              maxScale: 5,
              child: Center(
                child: Image.memory(
                  widget.pages[i],
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  errorBuilder: (_, _, _) => const Text('This file could not be shown.'),
                ),
              ),
            ),
          ),
        ),
        if (widget.pages.length > 1)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text('Page ${_page + 1} of ${widget.pages.length}', style: TextStyle(color: c.muted)),
          ),
      ],
    );
  }
}
