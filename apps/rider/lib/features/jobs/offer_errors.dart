import '../../core/api.dart';

/// What to tell the rider when accepting or rejecting an offer is refused
/// (`/api/rider/offers/:id/accept|reject`), in plain words. Every code those
/// routes can answer has its own sentence; anything else gets the general
/// one.
String offerError(Object error) {
  if (error is! ApiException) return 'Something went wrong. Please try again.';
  return switch (error.code) {
    'reserved' => 'Another rider is holding this order',
    'offer_expired' => 'Your time to accept this order ran out.',
    'already_taken' => 'Another rider has already taken this order.',
    'not_ready' => 'This order is not ready for pickup yet. Try again when the shop has packed it.',
    'not_online' => 'Go online to accept orders.',
    'documents_expired' => 'Your documents have expired. Upload new ones in Profile & documents to take jobs.',
    'rejected' => 'You turned this order down earlier, so you cannot take it now.',
    'not_offered' => 'This order is no longer offered to you.',
    'invalid_reason' => 'Choose a reason before you send.',
    'migration_pending' => 'Deligro is updating. Try again in a while.',
    'network' => 'No connection. Check your internet and try again.',
    _ => error.friendly,
  };
}

/// Whether the refusal is one the rider fixes in Profile & documents, so the
/// notice offers a way there.
bool offerErrorOpensProfile(Object error) => error is ApiException && error.code == 'documents_expired';
