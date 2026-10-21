import 'package:flutter_riverpod/flutter_riverpod.dart';

/// "Now" for anything that counts down or expires, so a test can move time by
/// hand. The offer countdown runs on the phone's clock against the board's
/// `offerExpiresAt`.
final clockProvider = Provider<DateTime Function()>((_) => DateTime.now);
