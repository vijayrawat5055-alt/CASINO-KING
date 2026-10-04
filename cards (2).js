// Playing-card art drawn for CASINO KING: ornate aces, classic-style court cards, simple number cards
(function(){
var RED='#c0262d',BLK='#111',INK='#222',GOLD='#f2c230',BLUE='#2a6db5',SKIN='#f6dcc0';
var SUIT=[
 '<path d="M50 6C22 38 6 54 22 70C33 80 46 74 48 62C47 76 42 84 33 92H67C58 84 53 76 52 62C54 74 67 80 78 70C94 54 78 38 50 6Z"/>',
 '<path d="M50 90C8 60 4 30 27 20C40 15 48 24 50 33C52 24 60 15 73 20C96 30 92 60 50 90Z"/>',
 '<circle cx="50" cy="28" r="19"/><circle cx="28" cy="58" r="19"/><circle cx="72" cy="58" r="19"/><path d="M43 58Q46 80 36 92H64Q54 80 57 58Z"/>',
 '<path d="M50 5L90 50L50 95L10 50Z"/>'];
var NAME=['spades','hearts','clubs','diamonds'];
var FIL='<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><circle cx="50" cy="50" r="11"/><circle cx="50" cy="50" r="4"/><circle cx="33" cy="40" r="6"/><circle cx="67" cy="40" r="6"/><path d="M50 24V39M50 61V78M30 62Q40 70 50 61Q60 70 70 62"/></g>';
function fig(r){
 var g='<path d="M4 48L12 33Q36 24 60 33L68 48Z" fill="'+BLUE+'" stroke="'+INK+'"/><path d="M18 48L36 34L54 48" fill="none" stroke="'+GOLD+'" stroke-width="6"/><path d="M8 43H64" stroke="'+RED+'" stroke-width="3"/>';
 g+='<path d="M56 48V12" stroke="'+GOLD+'" stroke-width="3"/><circle cx="56" cy="10" r="3.5" fill="'+GOLD+'" stroke="'+INK+'" stroke-width=".8"/>';
 if(r===12)g+='<path d="M20 20Q16 38 27 41M44 20Q48 38 37 41" stroke="'+GOLD+'" stroke-width="6" fill="none" stroke-linecap="round"/>';
 g+='<ellipse cx="32" cy="21" rx="9" ry="10" fill="'+SKIN+'" stroke="'+INK+'"/><path d="M29 19h2M35 19h2M32 21v4" stroke="'+INK+'" fill="none"/>';
 if(r===13)g+='<path d="M23 24Q32 44 41 24Q38 33 32 34Q26 33 23 24Z" fill="#cfcfcf" stroke="'+INK+'" stroke-width=".8"/><path d="M21 12L22 2L27 8L32 0L37 8L42 2L43 12Z" fill="'+GOLD+'" stroke="'+INK+'" stroke-width=".8"/><rect x="21" y="11" width="22" height="3" fill="'+RED+'"/>';
 else if(r===12)g+='<path d="M22 12L24 4L28 9L32 2L36 9L40 4L42 12Z" fill="'+GOLD+'" stroke="'+INK+'" stroke-width=".8"/><rect x="22" y="11" width="20" height="3" fill="'+RED+'"/>';
 else g+='<path d="M21 14Q32 -4 44 13Z" fill="'+RED+'" stroke="'+INK+'" stroke-width=".8"/><rect x="21" y="12" width="23" height="3" fill="'+GOLD+'"/><path d="M44 8Q56 2 58 14" stroke="'+GOLD+'" stroke-width="3" fill="none"/><path d="M26 25Q32 28 38 25" stroke="'+INK+'" stroke-width="1.2" fill="none"/>';
 return g}
window.cardSVG=function(r,s){
 var c=s%2?RED:BLK,L={11:'J',12:'Q',13:'K',14:'A'}[r]||String(r),mid='';
 function idx(rot){return '<g fill="'+c+'"'+(rot?' transform="rotate(180 50 70)"':'')+'><text x="11" y="20" font-size="19" font-weight="700" font-family="Georgia,serif" text-anchor="middle">'+L+'</text><g transform="translate(4 24) scale(.14)">'+SUIT[s]+'</g></g>'}
 if(r===14)mid='<g transform="translate(19 39) scale(.62)" fill="'+c+'">'+SUIT[s]+FIL+'</g>';
 else if(r>=11)mid='<rect x="22" y="22" width="56" height="96" fill="#fffdf4" stroke="'+c+'" stroke-width="1.2"/><g transform="translate(22 22) scale(.78 1)">'+fig(r)+'</g><g transform="rotate(180 50 70) translate(22 22) scale(.78 1)">'+fig(r)+'</g><path d="M22 70H78" stroke="'+c+'"/>';
 else mid='<text x="50" y="76" font-size="38" font-weight="700" font-family="Georgia,serif" text-anchor="middle" fill="'+c+'">'+L+'</text><g transform="translate(35 84) scale(.3)" fill="'+c+'">'+SUIT[s]+'</g>';
 return '<svg viewBox="0 0 100 140" role="img" aria-label="'+L+' of '+NAME[s]+'"><rect x=".6" y=".6" width="98.8" height="138.8" rx="7" fill="#fff" stroke="#999" stroke-width="1.2"/>'+mid+idx(0)+idx(1)+'</svg>'};
})();

// Real card pictures from a folder called "cards" or "png cards" (public-domain set: files like "ace of spades.png", "king of hearts.png", "7 of clubs.png").
// Short names such as AS.png / KH.png / 10D.png also work. A card without a picture falls back to the drawn version above.
(function(){
 var USE=null,W=['','','two','three','four','five','six','seven','eight','nine','ten'],pend=2;
 function done(ok){if(ok&&USE!==true){USE=true;if(window.render)window.render()}else if(!ok&&--pend===0&&USE===null)USE=false}
 ['AS','ace%20of%20spades'].forEach(function(n){var P=new Image();P.onload=function(){done(true)};P.onerror=function(){done(false)};P.src='/cards/'+n+'.png'});
 window.cardNext=function(el){var a=el.getAttribute('data-n').split('|'),i=+el.getAttribute('data-i')+1;
  if(i<a.length){el.setAttribute('data-i',i);el.src='/cards/'+encodeURIComponent(a[i])+'.png'}
  else{el.onerror=null;el.outerHTML=window.cardSVG(+el.getAttribute('data-r'),+el.getAttribute('data-s'))}};
 window.cardFace=function(r,s){
  if(USE!==true)return window.cardSVG(r,s);
  var su=NAME[s],nm=({11:'jack',12:'queen',13:'king',14:'ace'}[r]),L=({11:'J',12:'Q',13:'K',14:'A'}[r]||r),
   a=nm?[nm+' of '+su,L+'SHCD'[s]]:[W[r]+' of '+su,r+' of '+su,L+'SHCD'[s]];
  return '<img src="/cards/'+encodeURIComponent(a[0])+'.png" data-n="'+a.join('|')+'" data-i="0" data-r="'+r+'" data-s="'+s+'" alt="'+a[0]+'" onerror="cardNext(this)">'};
})();
