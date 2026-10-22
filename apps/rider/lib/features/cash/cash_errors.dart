import '../../core/api.dart';
import '../../core/money.dart';

/// What to tell the rider when a cash call fails. The codes are the cash
/// routes' own (src/app/api/rider/cash); anything else falls back to the
/// app-wide wording.
String cashErrorText(Object error) {
  if (error is! ApiException) return 'Check your connection and try again.';
  final available = error.body['available'];
  return switch (error.code) {
    'exceeds_pending' =>
      available is num
          ? 'You can deposit at most ${money(available)} right now. '
                'Cash you have already sent is waiting for a manager.'
          : 'That is more than the cash you are holding.',
    'invalid_amount' => 'Enter a whole number of rupees above zero.',
    'reference_required' => 'Enter the UPI reference for this payment.',
    'bad_photo' => 'That photo could not be used. Use a JPEG or PNG under 5 MB.',
    'invalid_manager' => 'Choose a manager from the list.',
    'invalid_note' => 'That note is too long.',
    'already_decided' => 'A manager has already looked at this deposit.',
    'already_open' => 'You have already reported a problem for this day.',
    'invalid_day' => 'You can only report a problem for the last 90 days.',
    'message_required' => 'Tell us what looks wrong (up to 500 characters).',
    'rate_limited' => 'Too many tries. Please wait a moment.',
    _ => error.friendly,
  };
}
