import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/support.dart';
import '../../state/safety.dart';
import '../../theme/app_theme.dart';
import '../help/attachments.dart';

const _noteMax = 500;

/// A safety report: unsafe situation, accident, breakdown, harassment or
/// threats, suspicious order or location. It goes to Deligro ops as an
/// emergency ticket, with the note, up to four photos and the rider's location.
class IncidentReportScreen extends ConsumerStatefulWidget {
  const IncidentReportScreen({super.key, required this.kind});

  final SosKind kind;

  @override
  ConsumerState<IncidentReportScreen> createState() => _IncidentReportScreenState();
}

class _IncidentReportScreenState extends ConsumerState<IncidentReportScreen> {
  final _note = TextEditingController();
  List<File> _photos = [];
  bool _sending = false;
  bool _sent = false;
  String? _error;
  bool? _hasPosition;

  @override
  void initState() {
    super.initState();
    _note.addListener(() => setState(() {}));
    alertPosition(ref).then((p) {
      if (mounted) setState(() => _hasPosition = p != null);
    });
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  String _errorText(Object e) {
    final base = e is ApiException
        ? switch (e.code) {
            'network' => 'Not sent. Check your connection and try again.',
            'too_many_photos' => 'Only 4 photos can be attached.',
            'photo_too_large' => 'A photo is over 5 MB. Choose a smaller one.',
            'bad_photo_type' => 'Only JPEG or PNG photos can be sent.',
            'invalid_note' => 'The note is too long.',
            _ => 'Not sent. Try again.',
          }
        : 'Not sent. Try again.';
    return '$base If you are in danger, call 112 or Deligro support.';
  }

  Future<void> _send() async {
    if (_sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final here = await alertPosition(ref);
      await ref.read(safetyRepoProvider).sos(
            kind: widget.kind,
            lat: here?.lat,
            lng: here?.lng,
            note: _note.text,
            photos: _photos,
          );
      if (!mounted) return;
      // The server answered 2xx: now, and only now, ops have been alerted.
      setState(() {
        _sending = false;
        _sent = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = _errorText(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(widget.kind.label)),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          key: const Key('incident-form'),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
          child: _sent ? _Done(onDone: () => context.pop()) : _form(context, c),
        ),
      ),
    );
  }

  Widget _form(BuildContext context, AppColors c) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Tell Deligro what is happening. Deligro ops treat this report as urgent.',
            style: TextStyle(color: c.muted, height: 1.4),
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('incident-note'),
            controller: _note,
            minLines: 4,
            maxLines: 8,
            maxLength: _noteMax,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(hintText: 'What happened? (optional)'),
          ),
          const SizedBox(height: 8),
          PhotoAttachments(photos: _photos, onChanged: (p) => setState(() => _photos = p)),
          const SizedBox(height: 14),
          Row(
            key: const Key('incident-location'),
            children: [
              Icon(
                _hasPosition == false ? Icons.location_off_outlined : Icons.my_location_rounded,
                size: 20,
                color: c.muted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _hasPosition == false
                      ? "Your location isn't available. The report goes without it."
                      : 'Your location is sent with the report.',
                  style: TextStyle(color: c.muted),
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 14),
            Text(
              _error!,
              key: const Key('incident-error'),
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w700, height: 1.35),
            ),
          ],
          const SizedBox(height: 18),
          FilledButton(
            key: const Key('send-incident'),
            onPressed: _sending ? null : _send,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
            child: _sending
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Send report'),
          ),
        ],
      );
}

class _Done extends StatelessWidget {
  const _Done({required this.onDone});

  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          key: const Key('incident-sent'),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: c.greenSoft, borderRadius: BorderRadius.circular(radiusBlock)),
          child: Row(
            children: [
              Icon(Icons.check_circle_rounded, color: c.green),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Report sent. Deligro ops have been alerted.',
                  style: TextStyle(color: c.green, fontWeight: FontWeight.w800, fontSize: 16),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          key: const Key('incident-done'),
          onPressed: onDone,
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
