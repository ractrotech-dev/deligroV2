import 'package:deligro_manager/core/api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a photo is sent as an image, not application/octet-stream', () {
    expect(uploadType('dish.JPG')?.mimeType, 'image/jpeg');
    expect(uploadType('logo.png')?.mimeType, 'image/png');
    expect(uploadType('x.webp')?.mimeType, 'image/webp');
    expect(uploadType('licence.pdf')?.mimeType, 'application/pdf');
    expect(uploadType('menu.xlsx')?.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(uploadType('noext'), isNull);
  });
}
