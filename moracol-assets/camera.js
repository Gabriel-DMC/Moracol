export function cameraErrorMessage(error) {
  switch(error?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return 'El acceso a la cámara está bloqueado. Abrí los permisos de este sitio en tu navegador y permití Cámara. Revisá también el permiso de cámara del navegador en los ajustes del dispositivo. Después pulsá Reintentar cámara.';
    case 'NotFoundError': case 'DevicesNotFoundError':
      return 'No se encontró una cámara. Conectá una cámara o abrí Moracol en un dispositivo que tenga una y volvé a intentar.';
    case 'NotReadableError': case 'TrackStartError':
      return 'No se pudo utilizar la cámara. Cerrá otras aplicaciones que puedan estar usándola y revisá los permisos del dispositivo. Después volvé a intentar.';
    case 'OverconstrainedError':
      return 'La cámara no admite la configuración solicitada. Probá con otro navegador o dispositivo.';
    case 'TimeoutError':
      return 'La cámara no respondió a tiempo. Si hay una solicitud de permiso, respondela. Luego pulsá Reintentar cámara. Si abriste Moracol dentro de otra app, probá abrirlo directamente en tu navegador.';
    case 'PlaybackError':
      return 'Se obtuvo acceso, pero el video no pudo iniciarse. Pulsá Reintentar cámara. Si continúa, abrí Moracol directamente en tu navegador.';
    default:
      return 'No se pudo iniciar la cámara. Volvé a intentar o abrí Moracol directamente en otro navegador.';
  }
}

// No consulta Permissions API: no todos los navegadores admiten el permiso camera.
export function createCameraController({video,mediaDevices,secureContext,onState,
  timeoutMs=25000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let generation=0,stream=null,pending=false,ready=false,timer=null,cancelWait=null;
  const release=s=>s?.getTracks().forEach(track=>track.stop());
  function cleanup(){
    if(timer!==null){clearTimer(timer);timer=null;}
    if(cancelWait){cancelWait();cancelWait=null;}
    release(stream);stream=null;ready=false;video.srcObject=null;
  }
  function stop(message='Cámara apagada. Pulsá Activar cámara para continuar.'){
    generation++;pending=false;cleanup();onState('idle',message);
  }
  async function start(){
    if(pending||ready)return;
    if(!secureContext){onState('error','La cámara requiere una conexión segura. Abrí https://moracol.pages.dev/ en tu navegador.');return;}
    if(!mediaDevices?.getUserMedia){onState('error','Este navegador no permite acceder a la cámara. Abrí Moracol directamente en Chrome, Edge, Firefox o Safari actualizado.');return;}
    const ticket=++generation;
    pending=true;onState('requesting','Respondé la solicitud de cámara de tu navegador. Solo se solicita cámara, no micrófono.');
    let stage='permission';
    const expired=new Promise((_,reject)=>{
      cancelWait=()=>reject(Object.assign(new Error(),{name:'AbortError'}));
      timer=setTimer(()=>reject(Object.assign(new Error(),{name:'TimeoutError'})),timeoutMs);
    });
    const acquire=async()=>{
      const acquired=await mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
      if(ticket!==generation){release(acquired);return;}
      stream=acquired;
      const tracks=stream.getVideoTracks();
      if(!tracks.length||tracks.some(t=>t.readyState==='ended'))throw Object.assign(new Error(),{name:'NotFoundError'});
      for(const track of tracks)track.addEventListener('ended',()=>{
        if(ticket!==generation)return;
        stop('La cámara se desconectó o se retiró el permiso. Pulsá Activar cámara para volver a conectarla.');
      },{once:true});
      stage='playback';video.muted=true;video.srcObject=stream;
      onState('requesting','Permiso obtenido. Iniciando el video…');
      await video.play();
      if(ticket!==generation)return;
      if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw Object.assign(new Error(),{name:'PlaybackError'});
      ready=true;pending=false;
      onState('ready','Cámara lista. Podés capturar el indicador.');
    };
    try{await Promise.race([acquire(),expired]);}
    catch(error){
      if(ticket!==generation)return;
      generation++;pending=false;cleanup();
      const detail=stage==='playback'&&error.name==='NotAllowedError'?{name:'PlaybackError'}:error;
      onState('error',cameraErrorMessage(detail));
    }finally{
      if(ticket===generation){if(timer!==null)clearTimer(timer);timer=null;cancelWait=null;}
    }
  }
  return {start,stop,isReady:()=>ready&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0};
}
