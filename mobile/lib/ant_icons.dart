// Ant Design icon glyphs used by the app, rendered from the bundled font at
// `assets/fonts/ant_icons.ttf`.
//
// Why vendored: the upstream `ant_icons` package declares its icons as
//
//   class AntIconData extends IconData { const AntIconData(int code) : ... }
//
// and `IconData` is a `final class` in current Flutter, so the package fails to
// compile outside its own library ("The class 'IconData' can't be extended
// outside of its library because it's a final class"). Subclassing was never
// needed: an icon is just a code point plus a font family, so the same glyphs
// are declared here directly. `assets/fonts/ant_icons.ttf` comes from that
// package, which is MIT licensed (Copyright (c) 2019 Venkatesh Prasad V M);
// the glyphs themselves are the Ant Design icon set by Ant Financial.
//
// To add another glyph: find its code point in the upstream package
// (`static const IconData <name> = AntIconData(0x....)`) and add a line below.
// Keep the `AntIcons` family name and the existing field names — call sites use
// `AntIcons.<name>` exactly as before.

// Upstream field names are snake_case (align_left, file_word, ...) and are kept
// verbatim so the icons stay drop-in compatible with the package.
// ignore_for_file: constant_identifier_names

import 'package:flutter/widgets.dart';

/// Font family declared for `assets/fonts/ant_icons.ttf` in `pubspec.yaml`.
const String _antIconsFontFamily = 'AntIcons';

abstract final class AntIcons {
  static const IconData align_left = IconData(0xea55, fontFamily: _antIconsFontFamily);
  static const IconData bar_chart = IconData(0xea6d, fontFamily: _antIconsFontFamily);
  static const IconData bg_colors = IconData(0xea73, fontFamily: _antIconsFontFamily);
  static const IconData border_horizontal = IconData(0xea79, fontFamily: _antIconsFontFamily);
  static const IconData check_circle = IconData(0xe869, fontFamily: _antIconsFontFamily);
  static const IconData check_outline = IconData(0xea8d, fontFamily: _antIconsFontFamily);
  static const IconData close = IconData(0xea93, fontFamily: _antIconsFontFamily);
  static const IconData delete_outline = IconData(0xeaaf, fontFamily: _antIconsFontFamily);
  static const IconData ellipsis = IconData(0xeac3, fontFamily: _antIconsFontFamily);
  static const IconData file_markdown_outline = IconData(0xead9, fontFamily: _antIconsFontFamily);
  static const IconData file_text_outline = IconData(0xeadf, fontFamily: _antIconsFontFamily);
  static const IconData file_word = IconData(0xe8a1, fontFamily: _antIconsFontFamily);
  static const IconData folder_open_outline = IconData(0xeae8, fontFamily: _antIconsFontFamily);
  static const IconData font_size = IconData(0xeaea, fontFamily: _antIconsFontFamily);
  static const IconData global = IconData(0xeaf7, fontFamily: _antIconsFontFamily);
  static const IconData history = IconData(0xeaff, fontFamily: _antIconsFontFamily);
  static const IconData html5 = IconData(0xe9ee, fontFamily: _antIconsFontFamily);
  static const IconData info_circle_outline = IconData(0xeb08, fontFamily: _antIconsFontFamily);
  static const IconData menu = IconData(0xeb25, fontFamily: _antIconsFontFamily);
  static const IconData minus_circle = IconData(0xea02, fontFamily: _antIconsFontFamily);
  static const IconData minus_outline = IconData(0xeb29, fontFamily: _antIconsFontFamily);
  static const IconData more = IconData(0xeb2f, fontFamily: _antIconsFontFamily);
  static const IconData picture = IconData(0xea0a, fontFamily: _antIconsFontFamily);
  static const IconData plus_circle = IconData(0xea0e, fontFamily: _antIconsFontFamily);
  static const IconData question_circle_outline = IconData(0xeb4e, fontFamily: _antIconsFontFamily);
  static const IconData right_outline = IconData(0xeb5d, fontFamily: _antIconsFontFamily);
  static const IconData setting_outline = IconData(0xeb6d, fontFamily: _antIconsFontFamily);
  static const IconData share_alt = IconData(0xeb6f, fontFamily: _antIconsFontFamily);
  static const IconData smile_outline = IconData(0xeb79, fontFamily: _antIconsFontFamily);
  static const IconData star = IconData(0xea31, fontFamily: _antIconsFontFamily);
  static const IconData table = IconData(0xeb8a, fontFamily: _antIconsFontFamily);
  static const IconData unordered_list = IconData(0xeb9b, fontFamily: _antIconsFontFamily);
  static const IconData warning = IconData(0xea47, fontFamily: _antIconsFontFamily);
}
