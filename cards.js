function court(r,c){
 const sk='#f3d3a8',gold='#e2b04a',st='#333';
 const head='<circle cx="30" cy="42" r="13" fill="'+sk+'" stroke="'+st+'"/><circle cx="25.5" cy="40" r="1.6" fill="'+st+'"/><circle cx="34.5" cy="40" r="1.6" fill="'+st+'"/><path d="M26 47q4 3 8 0" stroke="'+st+'" fill="none"/>';
 const body='<path d="M6 84q0-22 24-22q24 0 24 22z" fill="'+c+'"/><path d="M22 62l8 11l8-11" fill="#fff"/>';
 let top='';
 if(r===13)top='<path d="M18 46q12 26 24 0q-4 11-12 12q-8-1-12-12z" fill="#888"/><path d="M16 30l4-15l7 8l3-11l3 11l7-8l4 15z" fill="'+gold+'" stroke="#8a6a1a"/>';
 else if(r===12)top='<path d="M15 40q-4 28 9 30M45 40q4 28-9 30" stroke="#5a3a1a" fill="none" stroke-width="6"/><path d="M20 31l3-10l5 6l2-9l2 9l5-6l3 10z" fill="'+gold+'" stroke="#8a6a1a"/>';
 else top='<path d="M15 36q15-24 30 0z" fill="'+c+'"/><path d="M42 26q12-8 13 6" stroke="'+gold+'" fill="none" stroke-width="3"/>';
 return '<svg viewBox="0 0 60 84" role="img" aria-hidden="true">'+body+head+top+'</svg>';
}
