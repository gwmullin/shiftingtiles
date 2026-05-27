(function( $ ){

  const TILE_SIZES = {
    1: { single: 16, dual: 8 },  // small
    2: { single: 24, dual: 12 },
    3: { single: 40, dual: 20 }, // medium (default)
    4: { single: 50, dual: 25 },
    5: { single: 80, dual: 40 }  // extra large
  };

  $.fn.shiftingtiles = function(imagesOrCommand, options) {
    var where = this;
    
    // Check if we are running a command
    if (typeof imagesOrCommand === "string") {
      var command = imagesOrCommand;
      var instance = where.data("shiftingtiles");
      if (instance && typeof instance[command] === "function") {
        return instance[command].apply(instance, Array.prototype.slice.call(arguments, 1));
      }
      return this;
    }
    
    // Otherwise, initialize
    var images = imagesOrCommand;
    var settings = $.extend({
      photosource: images,
      duration: 5000,
      rows: 2,
      tileSize: 3
    }, options);
    
    var timeout;
    
    // Setup listeners (once)
    where.off(".shiftingtiles"); // Clear any old event namespace
    where.on("animationend webkitAnimationEnd oAnimationEnd.shiftingtiles", ".leave > .row", function(){
      $(this).parent().addClass("left").removeClass("leave");
    });
    where.on("animationend webkitAnimationEnd oAnimationEnd.shiftingtiles", ".disappear", function(){
      $(this).css("display", "none").remove();
      where.trigger("st-animate-after");
      return false;
    });

    // Source function
    function source(){
      if(typeof images.bottom == "undefined")
        images.bottom = 0;

      var index = images.bottom + Math.floor((images.length - images.bottom) * Math.random());
      var one = images.splice(index, 1)[0];
      images.unshift(one);

      images.bottom++;

      if(images.bottom == images.length){
        images.bottom = 0;
        where.trigger("st-galleryrestart");
      }

      return one;
    }

    // Add background image from source to jQuery element
    function image($element){
      var item = source();
      if (!item) return;
      var src = item.src;
      var focalX = (item.focal && typeof item.focal.x === "number") ? item.focal.x : 0.5;
      var focalY = (item.focal && typeof item.focal.y === "number") ? item.focal.y : 0.5;
      var focalXPct = focalX * 100;
      var focalYPct = focalY * 100;

      $element.css("background-image", "url("+src+")");
      $element.css("background-position", focalXPct+"% "+focalYPct+"%");
      $element.removeClass("pan-wide");
      $element.css({
        "--pan-y": focalYPct+"%",
        "--pan-start-x": Math.min(100, focalXPct + 25)+"%",
        "--pan-end-x": Math.max(0, focalXPct - 25)+"%"
      });

      if (item.aspect && item.aspect > (16 / 9)) {
        $element.addClass("pan-wide");
      }
    }

    // Figure out single or dual and add images
    function addImage(index, node){
      var $node = $(node);
      if($node.hasClass("single") || $node.parent(".dual").length > 0){
        image($node);
      } else if($node.hasClass("dual")) {
        $node.children().each(function(){
          image($(this));
        });
      }
      return $node;
    }

    // Dynamic grid building
    function buildGrid() {
      where.empty();
      where.addClass("shiftingtiles");
      
      var sizeConfig = TILE_SIZES[settings.tileSize || 3];
      var disappearDuration = Math.min(1.5, Math.max(0.3, settings.duration / 5000)) + 's';
      
      where.each(function() {
        this.style.setProperty('--row-height', (100 / settings.rows) + '%');
        this.style.setProperty('--single-width', (sizeConfig.single / 2) + '%');
        this.style.setProperty('--dual-width', (sizeConfig.dual / 2) + '%');
        this.style.setProperty('--disappear-duration', disappearDuration);
      });
      
      for (var r = 0; r < settings.rows; r++) {
        var $row = $("<div class='row'></div>");
        where.append($row);
        
        var currentWidth = 0;
        var singlePercent = sizeConfig.single / 2;
        var dualPercent = sizeConfig.dual / 2;
        
        while (currentWidth < 60) {
          var isSingle = Math.random() > 0.4;
          if (isSingle) {
            $row.append("<div class='single'></div>");
            currentWidth += singlePercent;
          } else {
            $row.append("<div class='dual'><div></div><div></div></div>");
            currentWidth += dualPercent;
          }
        }
      }
      
      where.append("<div class='loading'>Loading Photos...</div>");
      where.find(".single, .dual > div").each(function(idx, el) {
        addImage(0, el);
      });
    }

    // Animate frame
    function frame(){
      clearTimeout(timeout);
      var boxes = where.find(".single:not(:last-child), .dual:not(:last-child)");
      if (boxes.length === 0) return;
      
      var disappear = $(boxes.get( ~~(Math.random() * boxes.length) ));

      where.trigger("st-animate-before", disappear);

      disappear.parent().append(addImage(0, disappear.clone()));
      disappear.addClass("disappear");
      where.trigger("st-animate", disappear);

      timeout = setTimeout(frame, settings.duration);
    }

    // Keydown handler
    $(document.body).off(".shiftingtiles").on("keydown.shiftingtiles", function(e){
      if(e.keyCode == 32){ 
        frame();
        e.preventDefault();
        return false;
      }
      if(e.keyCode == 38){
        where.toggleClass("leave");
      }
    });

    // Initialize state object for external control
    var instance = {
      update: function(newOptions) {
        var oldRows = settings.rows;
        var oldSize = settings.tileSize;
        var oldDuration = settings.duration;
        
        $.extend(settings, newOptions);
        
        var sizeConfig = TILE_SIZES[settings.tileSize || 3];
        var disappearDuration = Math.min(1.5, Math.max(0.3, settings.duration / 5000)) + 's';
        
        where.each(function() {
          this.style.setProperty('--row-height', (100 / settings.rows) + '%');
          this.style.setProperty('--single-width', (sizeConfig.single / 2) + '%');
          this.style.setProperty('--dual-width', (sizeConfig.dual / 2) + '%');
          this.style.setProperty('--disappear-duration', disappearDuration);
        });
        
        if (settings.rows !== oldRows || settings.tileSize !== oldSize) {
          buildGrid();
        }
        
        if (settings.duration !== oldDuration) {
          clearTimeout(timeout);
          timeout = setTimeout(frame, settings.duration);
        }
      }
    };
    
    where.data("shiftingtiles", instance);

    // Initial grid construction and start timer
    buildGrid();
    timeout = setTimeout(frame, settings.duration);

    return this;
  };
})( jQuery );

if (!Array.prototype.reduce) {
  Array.prototype.reduce = function reduce(accumulator){
    if (this===null || this===undefined) throw new TypeError("Object is null or undefined");
    var i = 0, l = this.length >> 0, curr;
 
    if(typeof accumulator !== "function") // ES5 : "If IsCallable(callbackfn) is false, throw a TypeError exception."
      throw new TypeError("First argument is not callable");
 
    if(arguments.length < 2) {
      if (l === 0) throw new TypeError("Array length is 0 and no second argument");
      curr = this[0];
      i = 1; // start accumulating at the second element
    }
    else
      curr = arguments[1];
 
    while (i < l) {
      if(i in this) curr = accumulator.call(undefined, curr, this[i], i, this);
      ++i;
    }
 
    return curr;
  };
}
