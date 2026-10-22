import '../../core/api.dart';

/// What to tell a rider when a help-desk call did not go through.
String supportErrorText(Object error) {
  if (error is! ApiException) return "That didn't go through. Try again.";
  return switch (error.code) {
    'network' => 'No connection. Your message is still here. Try again when you have signal.',
    'invalid_message' => 'Write your message first (up to 4,000 characters).',
    'invalid_subject' => 'That subject is too long.',
    'invalid_category' => 'Pick what this is about.',
    'invalid_order' => 'That order is not one you delivered.',
    'too_many_photos' => 'Only 4 photos can be attached.',
    'photo_too_large' => 'A photo is over 5 MB. Choose a smaller one.',
    'bad_photo_type' => 'Only JPEG or PNG photos can be sent.',
    'not_found' => "We couldn't find that ticket.",
    _ => error.friendly,
  };
}
