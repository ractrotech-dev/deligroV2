/// The customer's wallet: points, 1 point = ₹1, whole rupees (`GET /api/wallet`).
class WalletInfo {
  const WalletInfo({required this.enabled, required this.balance, this.moves = const [], this.nextCursor});

  factory WalletInfo.fromJson(Map<String, dynamic> j) => WalletInfo(
        enabled: j['enabled'] == true,
        balance: (j['balance'] as num? ?? 0).floor(),
        moves: [
          for (final m in (j['moves'] as List? ?? const [])) WalletMove.fromJson(Map<String, dynamic>.from(m as Map)),
        ],
        nextCursor: j['nextCursor'] as String?,
      );

  /// Points can be added and used right now.
  final bool enabled;
  final int balance;
  final List<WalletMove> moves;

  /// Pass back to read older rows. Null at the end.
  final String? nextCursor;
}

class WalletMove {
  const WalletMove({
    required this.id,
    required this.amount,
    required this.kind,
    required this.reason,
    required this.orderId,
    required this.at,
  });

  factory WalletMove.fromJson(Map<String, dynamic> j) => WalletMove(
        id: '${j['id']}',
        amount: (j['amount'] as num? ?? 0).round(),
        kind: '${j['kind'] ?? 'legacy'}',
        reason: '${j['reason'] ?? ''}',
        orderId: j['orderId'] as String?,
        at: DateTime.tryParse('${j['at']}'),
      );

  /// + added, − used.
  final int amount;
  final String id;
  final String kind;
  final String reason;
  final String? orderId;
  final DateTime? at;

  /// What this row was, in plain words.
  String get label => switch (kind) {
        'change_credit' => 'Change from a cash order',
        'order_spend' => 'Used on an order',
        'order_return' => 'Returned, order cancelled',
        'order_adjust' => 'Returned, bill went down',
        'admin_correction' => 'Corrected by Deligro',
        _ => 'Opening balance',
      };
}

/// The most a customer can use on this bill: their balance, up to the bill.
int maxPointsFor(int balance, int total) {
  final top = balance < total ? balance : total;
  return top < 0 ? 0 : top;
}
