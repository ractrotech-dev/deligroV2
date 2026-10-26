import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/feature_routes.dart' show supportFeature;
import '../../core/format.dart';
import '../../core/navigation_launcher.dart';
import '../../models/support.dart';
import '../../state/support.dart';
import '../../state/providers.dart' show currentMeProvider, riderKeyProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'new_ticket_screen.dart';
import 'ticket_thread_screen.dart';

/// Help lives under More, so the tab bar stays under it.
final helpRoute = GoRoute(
  path: 'help',
  builder: (_, _) => const HelpScreen(),
  routes: [
    GoRoute(path: 'new', builder: (_, state) => NewTicketScreen(orderId: state.extra as String?)),
    GoRoute(
      path: 'tickets/:id',
      builder: (_, state) => TicketThreadScreen(id: state.pathParameters['id']!),
    ),
  ],
);

const helpPath = '/more/help';
String ticketPath(String id) => '$helpPath/tickets/$id';

/// The questions riders ask most, answered from what the app does.
const faqs = [
  (
    'How do I start getting orders?',
    'Open Home and go online. You get offers only while you are online and the app can see your location.',
  ),
  (
    'What if the customer does not answer?',
    'Tap Call customer on the delivery screen. If they still do not answer, tap Can\'t deliver? there and Deligro ops will decide what to do.',
  ),
  (
    'What if I lose signal during a delivery?',
    'Steps you tap are saved on your phone and sent when you have signal again. The delivery screen shows how many are waiting.',
  ),
  (
    'What does the SOS button do?',
    'Call 112 dials 112 from your phone. Alert Deligro sends your location to Deligro ops only. It does not call 112 or the police for you.',
  ),
  (
    'Where do I see my pay?',
    'Open Earnings. Deligro records your pay and payouts there.',
  ),
  (
    'Where do I see replies to my tickets?',
    'On the ticket in this screen, and in your Notifications.',
  ),
];

/// Contact Deligro, raise a ticket, follow the ones already open, and read the
/// answers to common questions.
class HelpScreen extends ConsumerWidget {
  const HelpScreen({super.key});

  Future<void> _open(BuildContext context, WidgetRef ref, Uri uri, String failed) async {
    final ok = await ref.read(urlOpenerProvider)(uri);
    if (!ok && context.mounted) showSnack(context, failed);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(supportOverviewProvider(ref.watch(riderKeyProvider)));
    final contact = ref.watch(supportContactProvider(ref.watch(riderKeyProvider))).value ?? SupportContact.none;
    // `driver.support` off (Admin → Feature access): no tickets. Calling and
    // WhatsApping Deligro, the questions, and Safety stay.
    final tickets = ref.watch(currentMeProvider)?.feature(supportFeature) ?? true;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: const Text('Help')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(supportOverviewProvider);
            await ref.read(supportOverviewProvider(ref.read(riderKeyProvider)).future).then<void>((_) {}, onError: (_) {});
          },
          child: ListView(
            key: const Key('help-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 28),
            children: [
              const RowsLabel('Talk to Deligro'),
              RowsCard(
                children: [
                  if (contact.hasPhone)
                    NavRow(
                      key: const Key('call-support'),
                      icon: Icons.call_outlined,
                      title: 'Call Deligro support',
                      subtitle: contact.phone,
                      onTap: () {
                        final uri = callUri(contact.phone);
                        if (uri != null) _open(context, ref, uri, "Couldn't open the phone app. Call ${contact.phone}.");
                      },
                    ),
                  if (contact.hasWhatsapp)
                    NavRow(
                      key: const Key('whatsapp-support'),
                      icon: Icons.chat_outlined,
                      title: 'WhatsApp Deligro',
                      subtitle: contact.whatsapp,
                      onTap: () {
                        final digits = contact.whatsapp!.replaceAll(RegExp(r'[^0-9]'), '');
                        if (digits.isEmpty) return;
                        _open(context, ref, Uri.parse('https://wa.me/$digits'), "Couldn't open WhatsApp.");
                      },
                    ),
                  if (tickets)
                    NavRow(
                      key: const Key('new-ticket'),
                      icon: Icons.edit_note_rounded,
                      title: 'Raise a ticket',
                      subtitle: contact.hasPhone || contact.hasWhatsapp
                          ? 'Write to Deligro with photos'
                          : "Deligro's phone numbers aren't set yet. Write to us here.",
                      onTap: () => context.push('$helpPath/new'),
                    ),
                ],
              ),
              if (tickets) ...[
                const RowsLabel('Your tickets'),
                overview.when(
                  skipLoadingOnRefresh: true,
                  loading: () => const Padding(
                    padding: EdgeInsets.symmetric(vertical: 28),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (e, _) => Panel(
                    child: Column(
                      children: [
                        Text("Couldn't load your tickets.", style: TextStyle(color: c.muted)),
                        TextButton(
                          key: const Key('tickets-retry'),
                          onPressed: () => ref.invalidate(supportOverviewProvider),
                          child: const Text('Try again'),
                        ),
                      ],
                    ),
                  ),
                  data: (o) => o.tickets.isEmpty
                      ? Panel(
                          key: const Key('no-tickets'),
                          child: Text(
                            'No tickets yet. When you write to Deligro, your tickets and their replies are here.',
                            style: TextStyle(color: c.muted, height: 1.4),
                          ),
                        )
                      : Column(
                          children: [
                            for (final t in o.tickets) ...[
                              TicketRow(ticket: t, onTap: () => context.push(ticketPath(t.id))),
                              const SizedBox(height: 10),
                            ],
                          ],
                        ),
                ),
              ],
              const RowsLabel('Common questions'),
              Material(
                color: c.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(radiusBlock),
                  side: BorderSide(color: c.line),
                ),
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: [
                    for (var i = 0; i < faqs.length; i++) ...[
                      if (i > 0) const Divider(),
                      Theme(
                        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                        child: ExpansionTile(
                          key: Key('faq-$i'),
                          tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                          expandedCrossAxisAlignment: CrossAxisAlignment.start,
                          title: Text(faqs[i].$1, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5)),
                          children: [Text(faqs[i].$2, style: TextStyle(color: c.muted, height: 1.4))],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A ticket in the list.
class TicketRow extends StatelessWidget {
  const TicketRow({super.key, required this.ticket, required this.onTap});

  final TicketSummary ticket;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = ticket;
    return Material(
      color: c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('ticket-${t.number}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: t.isEmergency && !t.isClosed ? c.deal : c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('#${t.number}', style: dataStyle(context, size: 14).copyWith(color: c.muted)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      t.categoryLabel,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TicketStatusChip(ticket: t),
              if (t.subject.isNotEmpty && t.subject != t.categoryLabel) ...[
                const SizedBox(height: 8),
                Text(
                  t.subject,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: c.muted, height: 1.3),
                ),
              ],
              const SizedBox(height: 6),
              Text(
                [
                  if (t.orderCode != null) 'Order ${t.orderCode}',
                  if (t.updatedAt != null) 'Updated ${placedAt(t.updatedAt)}',
                ].join(' · '),
                style: TextStyle(color: c.muted, fontSize: 12.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The ticket's status: the server's words, coloured by what is needed next.
class TicketStatusChip extends StatelessWidget {
  const TicketStatusChip({super.key, required this.ticket});

  final TicketSummary ticket;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg) = ticket.waitingOnRider
        ? (c.pop, c.popInk)
        : ticket.isClosed
            ? (c.surface2, c.muted)
            : ticket.isEmergency
                ? (c.dealSoft, c.deal)
                : (c.accentSoft, c.accentInk);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
      child: Text(
        ticket.statusLabel,
        style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 12.5),
      ),
    );
  }
}
