#!/usr/bin/env python3
"""Disposable native NPM SSO test. Local Docker only, no published ports or production volumes."""
import argparse, importlib.util, json, os, secrets, shutil, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('smoke', ROOT/'scripts/smoke.py')
smoke=importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--image',required=True);p.add_argument('--workdir',type=Path,required=True)
a=p.parse_args()
smoke.require(sys.platform=='linux' and os.geteuid()==0,'Run as root on a local Linux Docker test host')
smoke.require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'),'No Docker endpoint overrides')
context=json.loads(smoke.run('docker','context','inspect'))[0]
smoke.require(context['Endpoints']['docker']['Host'].startswith('unix://'),'Local Docker required')
image=json.loads(smoke.run('docker','image','inspect',a.image))[0]
smoke.require(image['Config']['Labels'].get('net.diamondcrew.sso')=='experimental-local','Expected local SSO image')
work=smoke.fresh_root(a.workdir);os.umask(0o077);work.mkdir(parents=True,mode=0o700)
for name in ('data','letsencrypt'): (work/name).mkdir(mode=0o700)
name='dci-sso-test-'+secrets.token_hex(6);initial=smoke.inventory();created=False;success=False
try:
    created=True
    smoke.run('docker','run','-d','--name',name,'--network','none','--label','net.diamondcrew.sso.test='+name,
              '--cpus','1','--memory','1g','-e','IP_RANGES_FETCH_ENABLED=false',
              '--mount',f'type=bind,source={work / "data"},target=/data',
              '--mount',f'type=bind,source={work / "letsencrypt"},target=/etc/letsencrypt',image['Id'])
    item=json.loads(smoke.run('docker','inspect',name))[0]
    smoke.require(not item['HostConfig'].get('PortBindings'),'Ports must not be published')
    smoke.require(item['HostConfig']['NetworkMode']=='none','Test must have no external network')
    smoke.require({m['Destination']:m['Source'] for m in item['Mounts']}=={'/data':str(work/'data'),'/etc/letsencrypt':str(work/'letsencrypt')},'Wrong test mounts')
    for script in ('native-check.mjs', 'native-diagnostics.mjs'):
        smoke.run('docker','cp',ROOT/'sso'/script,name+':/app/dci-sso/'+script)
    smoke.run('docker','exec',name,'node','/app/dci-sso/native-check.mjs',log=work/'native-test.log')
    success=True
finally:
    if created:
        found=json.loads(smoke.run('docker','inspect',name))[0]
        smoke.require(found['Config']['Labels'].get('net.diamondcrew.sso.test')==name,'Cleanup ownership mismatch')
        subprocess.run(['docker','inspect',name],stdout=(work/'container.inspect.json').open('w'),check=False)
        subprocess.run(['docker','logs',name],stdout=(work/'container.log').open('w'),stderr=subprocess.STDOUT,check=False)
        subprocess.run(['docker','rm','-f',name],check=True)
    status,details=smoke.compare_existing(initial)
    smoke.write_json(work/'report.json',{'native_sso':'PASS' if success else 'FAIL','existing_containers_unchanged':status,'details':details,'staff_broker':'NOT_RUN (synthetic adapter)','image_id':image['Id']})
    print('Private report:',work/'report.json')
sys.exit(0 if success and status=='PASS' else 1)
