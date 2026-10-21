import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../core/i18n.dart';
import '../../models/store.dart';
import '../../state/session.dart';
import '../../state/store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Store management (requirements §8): whether the shop is taking orders,
/// busy mode, hours and weekly off, holidays, prep time, delivery / pickup,
/// and the storefront details customers see.
class StoreScreen extends ConsumerWidget {
  const StoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(storeProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(tr(ref, 'Store', 'दुकान')),
        actions: [
          if (async.value?.canEdit ?? false)
            IconButton(
              tooltip: tr(ref, 'Edit details', 'जानकारी बदलें'),
              icon: const Icon(Icons.edit_outlined),
              onPressed: () => context.push('/more/store/edit'),
            ),
        ],
      ),
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.read(storeProvider.notifier).refresh(),
          child: _StoreBody(state: value),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(storeProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _StoreBody extends ConsumerWidget {
  const _StoreBody({required this.state});

  final StoreState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = state.store;
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        const SizedBox(height: 8),
        _StatusCard(state: state),
        if (state.canBusy && s.takingOrders) ...[
          SectionHeading(tr(ref, 'Busy mode', 'व्यस्त मोड')),
          _BusyPanel(store: s),
        ],
        SectionHeading(tr(ref, 'Opening hours', 'खुलने का समय')),
        _HoursPanel(store: s, canEdit: state.canEdit),
        if (s.scheduleSupported) ...[
          SectionHeading(
            tr(ref, 'Holidays', 'छुट्टियाँ'),
            trailing: state.canOpenClose
                ? TextButton.icon(
                    onPressed: () => _addHoliday(context, ref),
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: Text(tr(ref, 'Add', 'जोड़ें')),
                  )
                : null,
          ),
          _HolidaysPanel(store: s, canEdit: state.canOpenClose),
        ],
        SectionHeading(tr(ref, 'Orders', 'ऑर्डर')),
        _OrdersPanel(state: state),
        SectionHeading(tr(ref, 'Store details', 'दुकान की जानकारी')),
        _DetailsPanel(store: s),
      ],
    );
  }

  Future<void> _addHoliday(BuildContext context, WidgetRef ref) async {
    final now = DateTime.now();
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 365)),
      helpText: trNow(ref, 'Days the shop is closed', 'जिन दिनों दुकान बंद रहेगी'),
    );
    if (range == null || !context.mounted) return;
    final note = await _askText(
      context,
      ref,
      trNow(ref, 'Note (optional)', 'नोट (वैकल्पिक)'),
      hint: trNow(ref, 'e.g. Diwali', 'जैसे दिवाली'),
    );
    if (!context.mounted) return;
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(storeRepoProvider).addHoliday(isoDate(range.start), isoDate(range.end), note: note),
      doneEn: 'Holiday added',
      doneHi: 'छुट्टी जुड़ गई',
    );
    if (ok) ref.read(storeProvider.notifier).refresh();
  }
}

/// A one-line text prompt; null when cancelled or left empty.
Future<String?> _askText(BuildContext context, WidgetRef ref, String title, {String? hint}) async {
  final ctrl = TextEditingController();
  final text = await showDialog<String>(
    context: context,
    builder: (d) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        maxLength: 120,
        decoration: InputDecoration(hintText: hint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d, ''), child: Text(trNow(ref, 'Skip', 'छोड़ें'))),
        FilledButton(onPressed: () => Navigator.pop(d, ctrl.text), child: Text(trNow(ref, 'Save', 'सेव करें'))),
      ],
    ),
  );
  final t = text?.trim();
  return t == null || t.isEmpty ? null : t;
}

/// What customers see now, in a sentence.
(String, String) statusWords(StoreInfo s) {
  final until = s.closedUntil == null ? '' : DateFormat('h:mm a').format(s.closedUntil!);
  return switch (s.status) {
    'open' => ('Open · taking orders', 'खुली · ऑर्डर ले रहे हैं'),
    'temporarily_closed' => ('Closed until $until', '$until तक बंद'),
    'holiday' => ('Closed today · holiday', 'आज बंद · छुट्टी'),
    'weekly_off' => ('Closed today · weekly off', 'आज बंद · साप्ताहिक छुट्टी'),
    'outside_hours' => (
      'Closed now · opens ${clock12(s.openingTime)}',
      'अभी बंद · ${clock12(s.openingTime)} पर खुलेगी',
    ),
    _ => ('Closed · not taking orders', 'बंद · ऑर्डर नहीं ले रहे'),
  };
}

class _StatusCard extends ConsumerWidget {
  const _StatusCard({required this.state});

  final StoreState state;

  Future<void> _set(BuildContext context, WidgetRef ref, bool open, {int? forMinutes}) async {
    final ok = await runWrite(context, ref, () async {
      final s = await ref.read(storeRepoProvider).setOpen(open, closeForMinutes: forMinutes);
      ref.read(storeProvider.notifier).adopt(s);
    });
    // The home header and shop switcher read the open flag from /me.
    if (ok) ref.read(vendorMeProvider.notifier).reload();
  }

  Future<void> _close(BuildContext context, WidgetRef ref) async {
    final choice = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Text(
                  trNow(ref, 'Close the shop', 'दुकान बंद करें'),
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
              ),
              if (state.store.scheduleSupported)
                for (final (m, en, hi) in const [
                  (30, 'For 30 minutes', '30 मिनट के लिए'),
                  (60, 'For 1 hour', '1 घंटे के लिए'),
                  (120, 'For 2 hours', '2 घंटे के लिए'),
                  (240, 'For 4 hours', '4 घंटे के लिए'),
                ])
                  ListTile(
                    leading: const Icon(Icons.timer_outlined),
                    title: Text(trNow(ref, en, hi)),
                    subtitle: Text(trNow(ref, 'Opens again by itself', 'अपने आप फिर खुल जाएगी')),
                    onTap: () => Navigator.pop(sheet, m),
                  ),
              ListTile(
                leading: const Icon(Icons.do_not_disturb_on_outlined),
                title: Text(trNow(ref, 'Until I open it again', 'जब तक मैं फिर न खोलूँ')),
                onTap: () => Navigator.pop(sheet, 0),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
    if (choice == null || !context.mounted) return;
    await _set(context, ref, false, forMinutes: choice == 0 ? null : choice);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final s = state.store;
    final open = s.takingOrders;
    final (en, hi) = statusWords(s);
    // The master switch is on but the calendar or clock keeps it shut.
    final calendarClosed = s.isOpen && s.closedUntil == null && !open;
    return Panel(
      tint: open ? c.greenSoft : c.surface2,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(color: open ? c.green : c.muted, shape: BoxShape.circle),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  tr(ref, en, hi),
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: open ? c.green : c.ink),
                ),
              ),
            ],
          ),
          if (!s.approved) ...[
            const SizedBox(height: 8),
            Text(
              tr(
                ref,
                'Your shop is waiting for Deligro\'s approval. Customers can\'t see it yet.',
                'आपकी दुकान Deligro की मंज़ूरी का इंतज़ार कर रही है। ग्राहक अभी इसे नहीं देख सकते।',
              ),
              style: TextStyle(color: c.muted),
            ),
          ],
          if (calendarClosed) ...[
            const SizedBox(height: 8),
            Text(
              tr(
                ref,
                'Your hours, weekly off or a holiday keep the shop closed right now.',
                'आपका समय, साप्ताहिक छुट्टी या कोई छुट्टी अभी दुकान को बंद रख रही है।',
              ),
              style: TextStyle(color: c.muted),
            ),
          ],
          const SizedBox(height: 14),
          if (!state.canOpenClose)
            Text(
              tr(
                ref,
                'Deligro controls when this shop opens and closes.',
                'यह दुकान कब खुलेगी-बंद होगी, Deligro तय करता है।',
              ),
              style: TextStyle(color: c.muted),
            )
          else if (s.isOpen && s.closedUntil == null)
            OutlinedButton.icon(
              onPressed: () => _close(context, ref),
              icon: const Icon(Icons.storefront_outlined),
              label: Text(tr(ref, 'Close shop', 'दुकान बंद करें')),
            )
          else
            FilledButton.icon(
              onPressed: () => _set(context, ref, true),
              icon: const Icon(Icons.store_rounded),
              label: Text(tr(ref, 'Open shop now', 'अभी दुकान खोलें')),
            ),
        ],
      ),
    );
  }
}

class _BusyPanel extends ConsumerWidget {
  const _BusyPanel({required this.store});

  final StoreInfo store;

  Future<void> _set(BuildContext context, WidgetRef ref, int minutes) async {
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(storeRepoProvider).setBusy(minutes),
      doneEn: minutes == 0 ? 'Busy mode off' : 'Customers now see +$minutes min for the next hour',
      doneHi: minutes == 0 ? 'व्यस्त मोड बंद' : 'अगले एक घंटे ग्राहकों को +$minutes मिनट दिखेगा',
    );
    if (ok) ref.read(storeProvider.notifier).refresh();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final until = store.busyUntil == null ? '' : DateFormat('h:mm a').format(store.busyUntil!);
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            store.busy
                ? tr(
                    ref,
                    '+${store.busyExtraMinutes} min on every order until $until',
                    '$until तक हर ऑर्डर पर +${store.busyExtraMinutes} मिनट',
                  )
                : tr(
                    ref,
                    'Kitchen slammed? Add time to what customers are told, for an hour.',
                    'रसोई में भीड़? एक घंटे के लिए ग्राहकों को बताया गया समय बढ़ाएँ।',
                  ),
            style: TextStyle(color: store.busy ? c.ink : c.muted, fontWeight: store.busy ? FontWeight.w700 : null),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final m in const [10, 20, 30])
                ChoiceChip(
                  label: Text('+$m ${tr(ref, 'min', 'मिनट')}'),
                  selected: store.busyExtraMinutes == m,
                  onSelected: (_) => _set(context, ref, m),
                ),
              if (store.busy)
                ActionChip(
                  avatar: const Icon(Icons.close_rounded, size: 16),
                  label: Text(tr(ref, 'End now', 'अभी खत्म करें')),
                  onPressed: () => _set(context, ref, 0),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HoursPanel extends ConsumerWidget {
  const _HoursPanel({required this.store, required this.canEdit});

  final StoreInfo store;
  final bool canEdit;

  Future<void> _save(BuildContext context, WidgetRef ref, Map<String, Object?> fields) async {
    await runWrite(
      context,
      ref,
      () async {
        ref.read(storeProvider.notifier).adopt(await ref.read(storeRepoProvider).update(fields));
      },
      doneEn: 'Saved',
      doneHi: 'सेव हो गया',
    );
  }

  Future<void> _pickHours(BuildContext context, WidgetRef ref) async {
    final open = await showTimePicker(
      context: context,
      initialTime: timeOf(store.openingTime) ?? const TimeOfDay(hour: 10, minute: 0),
      helpText: trNow(ref, 'Opens at', 'खुलने का समय'),
    );
    if (open == null || !context.mounted) return;
    final close = await showTimePicker(
      context: context,
      initialTime: timeOf(store.closingTime) ?? const TimeOfDay(hour: 22, minute: 0),
      helpText: trNow(ref, 'Closes at', 'बंद होने का समय'),
    );
    if (close == null || !context.mounted) return;
    await _save(context, ref, {'openingTime': hhmmOf(open), 'closingTime': hhmmOf(close)});
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final hasHours = store.openingTime != null && store.closingTime != null;
    const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const shortHi = ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'];
    return Panel(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.schedule_rounded, color: c.ink),
            title: Text(
              hasHours
                  ? '${clock12(store.openingTime)} – ${clock12(store.closingTime)}'
                  : tr(ref, 'No fixed hours', 'कोई तय समय नहीं'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            subtitle: Text(
              hasHours
                  ? tr(ref, 'Orders are only taken in these hours', 'सिर्फ़ इसी समय में ऑर्डर आएँगे')
                  : tr(ref, 'Open whenever the shop is switched on', 'जब भी दुकान चालू हो, खुली'),
            ),
            trailing: canEdit
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (hasHours)
                        IconButton(
                          tooltip: tr(ref, 'Clear hours', 'समय हटाएँ'),
                          icon: const Icon(Icons.close_rounded),
                          onPressed: () => _save(context, ref, {'openingTime': null, 'closingTime': null}),
                        ),
                      IconButton(
                        tooltip: tr(ref, 'Set hours', 'समय तय करें'),
                        icon: const Icon(Icons.edit_outlined),
                        onPressed: () => _pickHours(context, ref),
                      ),
                    ],
                  )
                : null,
          ),
          const SizedBox(height: 4),
          Text(tr(ref, 'Weekly off', 'साप्ताहिक छुट्टी'), style: TextStyle(color: c.muted, fontSize: 12.5)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var i = 0; i < 7; i++)
                FilterChip(
                  label: Text(tr(ref, short[i], shortHi[i])),
                  selected: store.weeklyOff.contains(weekdayNames[i]),
                  onSelected: canEdit
                      ? (on) {
                          final next = {...store.weeklyOff};
                          on ? next.add(weekdayNames[i]) : next.remove(weekdayNames[i]);
                          _save(context, ref, {'weeklyOff': next.toList()});
                        }
                      : null,
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HolidaysPanel extends ConsumerWidget {
  const _HolidaysPanel({required this.store, required this.canEdit});

  final StoreInfo store;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final fmt = DateFormat('d MMM', isHindi(ref) ? 'hi_IN' : 'en_IN');
    if (store.holidays.isEmpty) {
      return Panel(
        child: Text(
          tr(
            ref,
            'No upcoming holidays. Add the days you\'ll be closed and customers won\'t be able to order.',
            'कोई आने वाली छुट्टी नहीं। जिन दिनों दुकान बंद रहेगी, उन्हें जोड़ें; उन दिनों ऑर्डर नहीं आएँगे।',
          ),
          style: TextStyle(color: c.muted),
        ),
      );
    }
    return Panel(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          for (final h in store.holidays)
            ListTile(
              leading: Icon(Icons.event_busy_rounded, color: c.deal),
              title: Text(
                h.startsOn == h.endsOn ? fmt.format(h.startsOn) : '${fmt.format(h.startsOn)} – ${fmt.format(h.endsOn)}',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: h.note == null ? null : Text(h.note!),
              trailing: canEdit
                  ? IconButton(
                      tooltip: tr(ref, 'Remove', 'हटाएँ'),
                      icon: const Icon(Icons.delete_outline_rounded),
                      onPressed: () async {
                        final ok = await runWrite(
                          context,
                          ref,
                          () => ref.read(storeRepoProvider).deleteHoliday(h.id),
                          doneEn: 'Holiday removed',
                          doneHi: 'छुट्टी हटाई',
                        );
                        if (ok) ref.read(storeProvider.notifier).refresh();
                      },
                    )
                  : null,
            ),
        ],
      ),
    );
  }
}

class _OrdersPanel extends ConsumerWidget {
  const _OrdersPanel({required this.state});

  final StoreState state;

  Future<void> _save(BuildContext context, WidgetRef ref, Map<String, Object?> fields) async {
    await runWrite(context, ref, () async {
      ref.read(storeProvider.notifier).adopt(await ref.read(storeRepoProvider).update(fields));
    });
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final s = state.store;
    final edit = state.canEdit;
    final prep = s.prepMinutes ?? state.defaultPrepMinutes;
    return Panel(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          SwitchListTile(
            secondary: Icon(Icons.delivery_dining_rounded, color: c.ink),
            title: Text(tr(ref, 'Delivery', 'डिलीवरी'), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(
              tr(ref, 'A Deligro rider brings orders to customers', 'Deligro राइडर ऑर्डर ग्राहक तक पहुँचाता है'),
            ),
            value: s.deliveryAvailable,
            onChanged: edit ? (v) => _save(context, ref, {'deliveryAvailable': v}) : null,
          ),
          SwitchListTile(
            secondary: Icon(Icons.shopping_bag_outlined, color: c.ink),
            title: Text(tr(ref, 'Self-pickup', 'सेल्फ़-पिकअप'), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(tr(ref, 'Customers collect from the shop', 'ग्राहक दुकान से खुद ले जाते हैं')),
            value: s.selfPickup,
            onChanged: edit ? (v) => _save(context, ref, {'selfPickup': v}) : null,
          ),
          ListTile(
            leading: Icon(Icons.timer_outlined, color: c.ink),
            title: Text(
              tr(ref, 'Preparation time', 'तैयारी का समय'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            subtitle: Text(
              s.prepMinutes == null
                  ? tr(
                      ref,
                      '${minutesText(prep)} (Deligro default)',
                      '${minutesText(prep, hi: true)} (Deligro डिफ़ॉल्ट)',
                    )
                  : minutesText(prep, hi: isHindi(ref)),
            ),
            trailing: edit ? const Icon(Icons.chevron_right_rounded) : null,
            onTap: edit ? () => _pickPrep(context, ref, prep) : null,
          ),
        ],
      ),
    );
  }

  Future<void> _pickPrep(BuildContext context, WidgetRef ref, int current) async {
    final picked = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                trNow(ref, 'How long does an order usually take?', 'एक ऑर्डर आमतौर पर कितनी देर में बनता है?'),
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final m in const [10, 15, 20, 25, 30, 40, 45, 60])
                    ChoiceChip(
                      label: Text(minutesText(m, hi: isHindi(ref))),
                      selected: m == current,
                      onSelected: (_) => Navigator.pop(sheet, m),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => Navigator.pop(sheet, -1),
                child: Text(
                  trNow(
                    ref,
                    'Use the Deligro default (${state.defaultPrepMinutes} min)',
                    'Deligro डिफ़ॉल्ट इस्तेमाल करें (${state.defaultPrepMinutes} मिनट)',
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !context.mounted) return;
    await _save(context, ref, {'prepMinutes': picked == -1 ? null : picked});
  }
}

class _DetailsPanel extends ConsumerWidget {
  const _DetailsPanel({required this.store});

  final StoreInfo store;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = store;
    final dash = tr(ref, 'Not set', 'नहीं डाला');
    final address = [s.address, s.landmark, s.pincode].where((p) => p != null && p.isNotEmpty).join(', ');
    return Panel(
      child: Column(
        children: [
          InfoRow(icon: Icons.storefront_outlined, label: tr(ref, 'Name', 'नाम'), value: s.name),
          if (s.tagline != null)
            InfoRow(icon: Icons.short_text_rounded, label: tr(ref, 'Tagline', 'टैगलाइन'), value: s.tagline!),
          InfoRow(
            icon: Icons.restaurant_menu_rounded,
            label: tr(ref, 'Cuisines', 'व्यंजन'),
            value: s.cuisines.isEmpty ? dash : s.cuisines.join(', '),
          ),
          if (s.scheduleSupported)
            InfoRow(
              icon: Icons.call_outlined,
              label: tr(ref, 'Shop phone', 'दुकान का फ़ोन'),
              value: s.shopPhone ?? dash,
            ),
          InfoRow(
            icon: Icons.place_outlined,
            label: tr(ref, 'Address', 'पता'),
            value: address.isEmpty ? dash : address,
          ),
          InfoRow(
            icon: Icons.my_location_rounded,
            label: tr(ref, 'Map location', 'नक्शे पर जगह'),
            value: s.lat == null ? dash : '${s.lat!.toStringAsFixed(5)}, ${s.lng!.toStringAsFixed(5)}',
          ),
        ],
      ),
    );
  }
}
