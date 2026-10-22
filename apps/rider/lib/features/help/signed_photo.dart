import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// A photo from a signed support or safety link. It is drawn with
/// [Image.network], which keeps the picture in memory only: the disk image
/// cache the rest of the app uses ([NetImage]) must never hold these, since
/// the link is private and the photo is evidence. Not for any other photo.
class SignedPhoto extends StatelessWidget {
  const SignedPhoto({super.key, required this.url, this.size = 84, this.radius = 10, this.fit = BoxFit.cover});

  final String url;
  final double size;
  final double radius;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget placeholder([IconData icon = Icons.image_outlined]) =>
        ColoredBox(color: c.surface2, child: Center(child: Icon(icon, color: c.muted)));
    return SizedBox(
      width: size,
      height: size,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: Image.network(
          url,
          fit: fit,
          cacheWidth: (size * 3).round(),
          loadingBuilder: (_, child, progress) => progress == null ? child : placeholder(),
          errorBuilder: (_, _, _) => placeholder(Icons.broken_image_outlined),
        ),
      ),
    );
  }
}
