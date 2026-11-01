// Clips the window's system blur (Electron's `vibrancy`, an NSVisualEffectView
// behind the web page) to the widget's own shape, and sets how strong it is.
//
// macOS blurs the whole window rectangle, but the window is much larger than
// the widget: it leaves room for the CSS drop shadow and for the biggest shape,
// and the rest is transparent and click-through. Unclipped, every shape would
// sit on a blurred 640×280 slab. Electron has no option for this, so this
// addon sets the effect view's maskImage to a rounded rect matching #widget.
//
// Unlike the old glass-capture helper this reads nothing off the screen, so it
// needs no Screen Recording permission and the bar shows up in screenshots.
//
// Built by scripts/build-backdrop-mask.sh into bin/backdrop-mask.node.

#define NAPI_VERSION 8
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

static NSVisualEffectView *FindEffectView(NSView *view) {
  if ([view isKindOfClass:[NSVisualEffectView class]]) return (NSVisualEffectView *)view;
  for (NSView *sub in view.subviews) {
    NSVisualEffectView *found = FindEffectView(sub);
    if (found) return found;
  }
  return nil;
}

static NSVisualEffectView *EffectViewOf(napi_env env, napi_value handle) {
  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, handle, &data, &len) != napi_ok || len < sizeof(void *)) {
    napi_throw_type_error(env, NULL, "handle must be the native window handle buffer");
    return nil;
  }
  NSView *view = (__bridge NSView *)(*(void **)data);
  // Electron inserts it into the content view, beneath the web contents. Not
  // searched from the frame view: the hidden title bar has an effect view too.
  return FindEffectView(view.window.contentView ?: view);
}

// setMask(handle, x, y, width, height, radius) -> boolean
//   handle: BrowserWindow.getNativeWindowHandle() (an NSView*)
//   rect:   window-local DIP, top-left origin, as getBoundingClientRect() gives
//   returns false when the window has no effect view (vibrancy not set)
static napi_value SetMask(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  napi_value result;
  if (argc < 6) {
    napi_throw_type_error(env, NULL, "setMask(handle, x, y, width, height, radius)");
    return NULL;
  }

  double nums[5];
  for (int i = 0; i < 5; i++) {
    if (napi_get_value_double(env, args[i + 1], &nums[i]) != napi_ok) {
      napi_throw_type_error(env, NULL, "x, y, width, height and radius must be numbers");
      return NULL;
    }
  }

  NSVisualEffectView *effect = EffectViewOf(env, args[0]);
  if (!effect) {
    napi_get_boolean(env, false, &result);
    return result;
  }

  NSSize size = effect.bounds.size;
  double x = nums[0], y = nums[1], w = fmax(0, nums[2]), h = fmax(0, nums[3]);
  // CSS caps border-radius at half the shorter side; so does this.
  double r = fmin(fmax(0, nums[4]), fmin(w, h) / 2);
  // Flip to AppKit's bottom-left origin.
  NSRect rect = NSMakeRect(x, size.height - y - h, w, h);
  effect.maskImage = [NSImage imageWithSize:size flipped:NO drawingHandler:^BOOL(NSRect dst) {
    [[NSColor blackColor] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:r yRadius:r] fill];
    return YES;
  }];

  napi_get_boolean(env, true, &result);
  return result;
}

// setBlur(handle, radius) -> boolean
//   radius: gaussian blur radius in points; macOS draws its materials at 30
//   returns false when there is nothing to set it on
//
// There is no public API for this. The effect view renders through a
// CABackdropLayer whose filter chain includes a "gaussianBlur" filter, and its
// inputRadius is settable by key path. If a macOS release reshapes that layer
// tree, nothing matches, this returns false and the system's own blur stays.
//
// The same layer samples the desktop at 1/8 resolution (its `scale`), which a
// 30pt blur hides but a light one shows as blocky pixels. So the sampling gets
// finer as the blur gets lighter, keeping each sampled pixel well under the
// blur radius, up to full resolution for clear glass.
static napi_value SetBlur(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  napi_value result;
  double radius;
  if (argc < 2 || napi_get_value_double(env, args[1], &radius) != napi_ok) {
    napi_throw_type_error(env, NULL, "setBlur(handle, radius)");
    return NULL;
  }
  NSVisualEffectView *effect = EffectViewOf(env, args[0]);
  bool applied = false;
  radius = fmax(0, radius);
  double scale = radius <= 4 ? 1.0 : fmin(1.0, fmax(0.125, 4.0 / radius));
  if (effect.layer) {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    NSMutableArray<CALayer *> *stack = [NSMutableArray arrayWithObject:effect.layer];
    while (stack.count) {
      CALayer *layer = stack.lastObject;
      [stack removeLastObject];
      if (layer.sublayers) [stack addObjectsFromArray:layer.sublayers];
      if (![NSStringFromClass([layer class]) containsString:@"Backdrop"]) continue;
      for (id filter in layer.filters) {
        if (![[filter valueForKey:@"name"] isEqual:@"gaussianBlur"]) continue;
        [layer setValue:@(radius) forKeyPath:@"filters.gaussianBlur.inputRadius"];
        [layer setValue:@(scale) forKey:@"scale"];
        applied = true;
      }
    }
    [CATransaction commit];
  }
  napi_get_boolean(env, applied, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "setMask", NAPI_AUTO_LENGTH, SetMask, NULL, &fn);
  napi_set_named_property(env, exports, "setMask", fn);
  napi_create_function(env, "setBlur", NAPI_AUTO_LENGTH, SetBlur, NULL, &fn);
  napi_set_named_property(env, exports, "setBlur", fn);
  return exports;
}
