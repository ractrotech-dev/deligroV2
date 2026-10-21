/// `/api/vendor/dashboard` (src/lib/data-access/vendor-dashboard.ts).
class Dashboard {
  const Dashboard({
    required this.todaySale,
    required this.yesterdaySale,
    required this.totalSale,
    required this.thisMonthSale,
    required this.lastMonthSale,
    required this.liveNew,
    required this.liveAccepted,
    required this.livePreparing,
    required this.liveReady,
    required this.todayOrders,
    required this.todayCompleted,
    required this.todayCancelled,
    required this.money,
    required this.marketing,
  });

  factory Dashboard.fromJson(Map<String, dynamic> j) {
    Map<String, dynamic> m(String k) => ((j[k] as Map?) ?? const {}).cast<String, dynamic>();
    int n(Map<String, dynamic> map, String k) => (map[k] as num?)?.round() ?? 0;
    final sales = m('sales'), live = m('live'), today = m('today'), mk = m('marketing');
    final money = (j['money'] as Map?)?.cast<String, dynamic>();
    return Dashboard(
      todaySale: n(sales, 'today'),
      yesterdaySale: n(sales, 'yesterday'),
      totalSale: n(sales, 'total'),
      thisMonthSale: n(sales, 'thisMonth'),
      lastMonthSale: n(sales, 'lastMonth'),
      liveNew: n(live, 'new'),
      liveAccepted: n(live, 'accepted'),
      livePreparing: n(live, 'preparing'),
      liveReady: n(live, 'ready'),
      todayOrders: n(today, 'orders'),
      todayCompleted: n(today, 'completed'),
      todayCancelled: n(today, 'cancelled'),
      money: money == null
          ? null
          : DashboardMoney(
              totalEarnings: n(money, 'totalEarnings'),
              paidOrders: n(money, 'paidOrders'),
              unpaidOrders: n(money, 'unpaidOrders'),
              partlyPaidOrders: n(money, 'partlyPaidOrders'),
              paymentDue: n(money, 'paymentDue'),
            ),
      marketing: MarketingCounts(
        available: mk['available'] == true,
        pending: n(mk, 'pending'),
        approved: n(mk, 'approved'),
        inProgress: n(mk, 'inProgress'),
        completed: n(mk, 'completed'),
        rejected: n(mk, 'rejected'),
      ),
    );
  }

  final int todaySale;
  final int yesterdaySale;
  final int totalSale;
  final int thisMonthSale;
  final int lastMonthSale;
  final int liveNew;
  final int liveAccepted;
  final int livePreparing;
  final int liveReady;
  final int todayOrders;
  final int todayCompleted;
  final int todayCancelled;

  /// Null when Deligro has switched Earnings off for the shop.
  final DashboardMoney? money;
  final MarketingCounts marketing;

  /// % change; null when the earlier figure is zero (nothing to compare).
  static double? change(int now, int before) => before == 0 ? null : ((now - before) / before * 1000).round() / 10;

  double? get todayChange => change(todaySale, yesterdaySale);
  double? get monthChange => change(thisMonthSale, lastMonthSale);
}

class DashboardMoney {
  const DashboardMoney({
    required this.totalEarnings,
    required this.paidOrders,
    required this.unpaidOrders,
    required this.partlyPaidOrders,
    required this.paymentDue,
  });

  final int totalEarnings;
  final int paidOrders;
  final int unpaidOrders;
  final int partlyPaidOrders;

  /// Positive: Deligro owes the shop. Negative: the shop owes Deligro.
  final int paymentDue;
}

class MarketingCounts {
  const MarketingCounts({
    required this.available,
    required this.pending,
    required this.approved,
    required this.inProgress,
    required this.completed,
    required this.rejected,
  });

  /// False until the server has the marketing requests table.
  final bool available;
  final int pending;
  final int approved;
  final int inProgress;
  final int completed;
  final int rejected;

  int get total => pending + approved + inProgress + completed + rejected;
}
